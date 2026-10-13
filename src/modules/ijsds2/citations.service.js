// Stage 2D/2E: citation extraction, Crossref/OpenAlex identity resolution, relevance
// scoring, related-article discovery (PRD §4.C).
//
// Rules this module enforces:
//  - Registry/network failure is NOT "unresolved". It throws ProviderError so the audit
//    job retries and, if still failing, goes to manual review (never silently clears).
//  - Recommendations only come from records returned by Crossref/OpenAlex, each with a
//    stable identifier. Nothing is invented, no placeholder fallback list.
//  - Nothing here rewrites the author's references.

const UA = `IJSDS-Integrity-Audit/2.0 (mailto:${process.env.CROSSREF_DEPOSITOR_EMAIL || "editor.ijsds@gmail.com"})`;
const TIMEOUT_MS = 12_000;

export class ProviderError extends Error {
  constructor(provider, message) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
    this.provider = provider;
  }
}

// ── Cache (PRD §6: cache DOI/metadata resolution to avoid repeat lookups) ───────────
const cache = new Map();
export const cacheStats = { hits: 0, misses: 0 };

const withOpenAlexKey = (url) =>
  process.env.OPENALEX_API_KEY && url.startsWith("https://api.openalex.org")
    ? `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}`
    : url;

const getJson = async (provider, rawUrl) => {
  const url = withOpenAlexKey(rawUrl);
  if (cache.has(rawUrl)) {
    cacheStats.hits++;
    return cache.get(rawUrl);
  }
  cacheStats.misses++;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(provider, e.message);
  }
  if (res.status === 404) {
    cache.set(rawUrl, null);
    return null;
  }
  if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`);
  const json = await res.json();
  cache.set(rawUrl, json);
  return json;
};

// ── Extraction ──────────────────────────────────────────────────────────────────────
const tokenize = (s) =>
  (s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set("the and for with that this from are was were has have had not but his her their our its into over under between about also been which while than then them they these those such can may will would should could".split(" "));
const terms = (s) => tokenize(s).filter((w) => !STOP.has(w));

export const extractCitations = ({ body_text, references_text }) => {
  const entries = references_text
    .split(/\n(?=\s*(?:\[\d+\]|\d+\.\s)|[A-Z][A-Za-z'\-]+,\s+[A-Z])/g)
    .map((e) => e.replace(/\s+/g, " ").replace(/^\s*(?:\[\d+\]|\d+\.)\s*/, "").trim())
    .filter((e) => e.length > 20);

  const references = entries.map((raw, i) => {
    const doi = raw.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/i)?.[0].replace(/[,;.\s]+$/, "");
    const year = Number(raw.match(/\b(19\d{2}|20\d{2})\b/)?.[1]) || undefined;
    const surname = raw.match(/^([A-Z][A-Za-z'\-]+)/)?.[1];
    // APA-style "Author, A. (2019). Title. Journal." — the full stop after the year is optional
    const title = raw.match(/(?:\(\d{4}[a-z]?\)|\b\d{4}[a-z]?)[.,]?\s*([^.]+?)\./)?.[1]?.trim();
    return {
      index: i + 1,
      raw,
      doi,
      year,
      title,
      authors: surname ? [{ last_name: surname }] : [],
      contexts: [],
    };
  });

  const uncited = new Set(references.map((r) => r.index));
  const orphaned = new Set();
  const sentences = body_text.split(/(?<=[.?!])\s+/);

  for (const s of sentences) {
    const sentence = s.trim();
    for (const m of sentence.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
      for (const part of m[1].split(",")) {
        const range = part.split(/[–-]/).map((n) => parseInt(n, 10));
        const [a, b] = range.length === 2 ? range : [range[0], range[0]];
        for (let n = a; n <= b && b - a < 200; n++) {
          const ref = references.find((r) => r.index === n);
          if (ref) {
            if (!ref.contexts.includes(sentence)) ref.contexts.push(sentence);
            uncited.delete(n);
          } else {
            orphaned.add(`[${n}]`);
          }
        }
      }
    }
    for (const ref of references) {
      const sn = ref.authors[0]?.last_name;
      if (!sn || !ref.year) continue;
      const esc = sn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${esc}(?:\\s+et\\s+al\\.?)?,?\\s*\\(?${ref.year}`, "i").test(sentence)) {
        if (!ref.contexts.includes(sentence)) ref.contexts.push(sentence);
        uncited.delete(ref.index);
      }
    }
  }

  return { references, orphaned_markers: [...orphaned], uncited_indices: [...uncited] };
};

// ── Resolution ──────────────────────────────────────────────────────────────────────
const jaccard = (a, b) => {
  const A = new Set(terms(a));
  const B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

const openAlexByDoi = (doi) =>
  getJson("OpenAlex", `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`);

const abstractFromInverted = (inv) => {
  if (!inv) return "";
  const out = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) out[p] = word;
  return out.join(" ");
};

/** Returns a resolution record. Throws ProviderError on registry/network failure. */
export const resolveReference = async (ref) => {
  const base = { resolvedDoi: null, crossrefId: null, openalexId: null, matchScore: 0, status: "UNRESOLVED", warnings: [], work: null };

  // 1. DOI exact match first (PRD §4.C.3)
  if (ref.doi) {
    const cr = await getJson("Crossref", `https://api.crossref.org/works/${encodeURIComponent(ref.doi)}`);
    if (cr?.message) {
      const w = cr.message;
      const regYear = w.issued?.["date-parts"]?.[0]?.[0] ?? w.published?.["date-parts"]?.[0]?.[0];
      const regTitle = w.title?.[0] ?? "";
      const warnings = [];
      if (ref.year && regYear && Math.abs(ref.year - regYear) > 1) warnings.push(`DATE_MISMATCH:cited=${ref.year},registry=${regYear}`);
      const titleSim = ref.title ? jaccard(ref.title, regTitle) : null;
      if (titleSim !== null && titleSim < 0.3) warnings.push("TITLE_MISMATCH");
      const oa = await openAlexByDoi(ref.doi);
      return {
        ...base,
        resolvedDoi: w.DOI,
        crossrefId: w.DOI,
        openalexId: oa?.id ?? null,
        matchScore: warnings.length ? 0.6 : 0.98,
        status: warnings.length ? "METADATA_MISMATCH" : "VALIDATED",
        warnings,
        work: { title: regTitle, year: regYear, abstract: abstractFromInverted(oa?.abstract_inverted_index) || (w.abstract ?? "").replace(/<[^>]+>/g, " "), openalex: oa },
      };
    }
    // DOI supplied but unknown to Crossref: fall through to bibliographic search, flag it.
    base.warnings.push("SUPPLIED_DOI_NOT_FOUND");
  }

  // 2. Normalized-metadata search
  const q = ref.title || ref.raw.slice(0, 160);
  const search = await getJson("Crossref", `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=3`);
  const items = search?.message?.items ?? [];
  let best = null;
  for (const it of items) {
    const sim = jaccard(q, it.title?.[0] ?? "");
    const yr = it.issued?.["date-parts"]?.[0]?.[0];
    const yearOk = !ref.year || !yr || Math.abs(ref.year - yr) <= 1;
    const score = sim * (yearOk ? 1 : 0.7);
    if (!best || score > best.score) best = { it, score, yr };
  }
  if (best && best.score >= 0.45) {
    const oa = await openAlexByDoi(best.it.DOI);
    return {
      ...base,
      resolvedDoi: best.it.DOI,
      crossrefId: best.it.DOI,
      openalexId: oa?.id ?? null,
      matchScore: Number(Math.min(best.score, 0.95).toFixed(5)),
      status: best.score >= 0.7 ? "VALIDATED" : "PARTIAL_MATCH",
      work: { title: best.it.title?.[0], year: best.yr, abstract: abstractFromInverted(oa?.abstract_inverted_index), openalex: oa },
    };
  }

  base.warnings.push("UNRESOLVED_REFERENCE");
  return base;
};

// ── Relevance (lexical-v1; embedding scorer plugs in behind the same signature) ─────
export const SCORER_VERSION = "lexical-v1";

export const scoreRelevance = (ref, resolution, cfg) => {
  const codes = [...resolution.warnings];
  if (ref.contexts.length === 0) codes.push("UNCITED_REFERENCE");
  if (resolution.status === "UNRESOLVED") codes.push("WEAK_METADATA_RESOLUTION");

  let score = null;
  const target = [resolution.work?.title, resolution.work?.abstract].filter(Boolean).join(" ");
  if (ref.contexts.length && target) {
    // Overlap is naturally small between a sentence and a title/abstract, so scale it.
    const sim = jaccard(ref.contexts.join(" "), target);
    score = Number(Math.min(sim * 4, 1).toFixed(5));
    if (score < cfg.citations.min_relevance) codes.push("WEAK_CONTEXT_SUPPORT");
  }
  return { score, codes };
};

// ── Related / cross-referenced articles via the OpenAlex reference graph ────────────
export const discoverRelated = async ({ abstract, resolutions, cfg }) => {
  const limit = cfg.related_list_size;
  if (!limit) return [];

  const own = new Set(resolutions.map((r) => r.openalexId).filter(Boolean));
  const freq = new Map();
  for (const r of resolutions) {
    const oa = r.work?.openalex;
    if (!oa) continue;
    for (const id of [...(oa.related_works ?? []), ...(oa.referenced_works ?? [])]) {
      if (!own.has(id)) freq.set(id, (freq.get(id) ?? 0) + 1);
    }
  }
  const ids = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id]) => id.split("/").pop());
  if (!ids.length) return [];

  const json = await getJson("OpenAlex", `https://api.openalex.org/works?filter=openalex_id:${ids.join("|")}&per-page=40&select=id,doi,title,publication_year,abstract_inverted_index`);
  const maxFreq = Math.max(...freq.values());
  const ranked = (json?.results ?? [])
    .filter((w) => w.title && (w.doi || w.id))
    .map((w) => {
      const prox = (freq.get(w.id) ?? 1) / maxFreq;
      const sem = Math.min(jaccard(abstract, `${w.title} ${abstractFromInverted(w.abstract_inverted_index)}`) * 4, 1);
      return {
        source: "OPENALEX",
        external_work_id: w.id,
        doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : null,
        title: w.title,
        publication_year: w.publication_year ?? null,
        graph_proximity_score: Number(prox.toFixed(5)),
        relevance_score: Number((0.6 * sem + 0.4 * prox).toFixed(5)),
        recommendation_reason: `Linked from ${freq.get(w.id) ?? 1} of this manuscript's resolved references (reference-graph proximity ${prox.toFixed(2)}, abstract similarity ${sem.toFixed(2)}).`,
      };
    })
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank_position: i + 1 }));
  return ranked;
};
