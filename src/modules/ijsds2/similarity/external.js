import { ProviderError } from "../citations.service.js";
import { fingerprint, containment, words } from "./shingles.js";

const UA = `IJSDS-Similarity/2.0 (mailto:${process.env.CROSSREF_DEPOSITOR_EMAIL || "editor.ijsds@gmail.com"})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (provider, url, headers = {}) => {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new ProviderError(provider, e.message);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new ProviderError(provider, "rate limited (HTTP 429)");
  if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`);
  return res.json();
};

/** Evenly spaced, distinctive sentences from the body: long enough to be quotable, little numeric noise. */
export const samplePassages = (bodyText, max) => {
  const pick = (items) => {
    if (items.length <= max) return items;
    const step = items.length / max;
    return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
  };
  const sentences = bodyText
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => {
      const n = words(s).length;
      return n >= 14 && n <= 45 && (s.match(/\d/g) ?? []).length < 6;
    });
  if (sentences.length >= max) return pick(sentences);

  // PDF extraction often loses sentence punctuation. Fall back to fixed 25-word windows so
  // a requested source never silently searches nothing.
  const ws = bodyText.split(/\s+/).filter(Boolean);
  const windows = [];
  for (let i = 0; i + 25 <= ws.length; i += 25) {
    const chunk = ws.slice(i, i + 25);
    // skip numeric tables (many purely numeric tokens), keep ordinary text
    if (chunk.filter((t) => /^[\d.,%()-]+$/.test(t)).length < 8) windows.push(chunk.join(" "));
  }
  return pick([...sentences, ...windows]);
};

/**
 * CORE full-text search (open-access literature). Free tier: ~5 single requests / 10 s, so
 * requests are spaced 2.1 s apart. Each hit is VERIFIED locally by fingerprint overlap; a
 * search hit alone never counts as similarity.
 */
export const checkCore = async (bodyText, entries, { maxQueries }) => {
  const key = process.env.CORE_API_KEY;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const passages = samplePassages(bodyText, maxQueries);
  const seen = new Map();
  let noText = 0;

  for (let i = 0; i < passages.length; i++) {
    if (i) await sleep(2100);
    const phrase = words(passages[i]).slice(0, 12).join(" ");
    const json = await getJson("CORE", `https://api.core.ac.uk/v3/search/works/?q=${encodeURIComponent(`"${phrase}"`)}&limit=5`, headers);
    for (const w of json?.results ?? []) {
      if (seen.has(w.id)) continue;
      if (!w.fullText) {
        noText++;
        seen.set(w.id, null);
        continue;
      }
      const set = new Set(fingerprint(w.fullText).entries.map((e) => e.h));
      seen.set(w.id, {
        source_title: w.title || "CORE open-access work",
        source_url: w.doi ? `https://doi.org/${w.doi}` : w.downloadUrl || `https://core.ac.uk/works/${w.id}`,
        set,
        containment: containment(entries, set),
      });
    }
  }
  if (!passages.length) throw new ProviderError("CORE", "no searchable passages could be sampled from the text");
  const docs = [...seen.values()].filter((d) => d && d.containment > 0.01).sort((a, b) => b.containment - a.containment);
  return { docs, queried: passages.length, noText };
};

const abstractFrom = (inv) => {
  if (!inv) return "";
  const out = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) out[p] = word;
  return out.join(" ");
};

/**
 * OpenAlex abstract-level duplicate check: catches an abstract (or near-copy) already
 * published elsewhere. It cannot see body copying — that needs full text (local archive/CORE).
 */
export const checkOpenAlexAbstract = async (title, abstract) => {
  const absEntries = fingerprint(abstract).entries;
  if (absEntries.length < 5) return { docs: [], skipped: "abstract too short" };
  const key = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : "";
  const json = await getJson(
    "OpenAlex",
    `https://api.openalex.org/works?search=${encodeURIComponent(title.slice(0, 200))}&per-page=8&select=id,doi,title,publication_year,abstract_inverted_index${key}`,
  );
  const docs = [];
  for (const w of json?.results ?? []) {
    const text = abstractFrom(w.abstract_inverted_index);
    if (!text) continue;
    const c = containment(absEntries, new Set(fingerprint(text).entries.map((e) => e.h)));
    if (c >= 0.25) {
      docs.push({
        source_title: `${w.title} (${w.publication_year ?? "n.d."})`,
        source_url: w.doi ?? w.id,
        containment: c,
      });
    }
  }
  return { docs: docs.sort((a, b) => b.containment - a.containment) };
};
