import { registerPlagiarismProvider } from "./registry.js";
import { ProviderError } from "../citations.service.js";
import { fingerprint, matchedPassages } from "../similarity/shingles.js";
import { findLocalOverlaps } from "../similarity/fingerprints.service.js";
import { checkCore, checkOpenAlexAbstract } from "../similarity/external.js";

// Free, built-in similarity provider (PLAGIARISM_PROVIDER=open). It is a PARTIAL check and
// says so in every report: it sees IJSDS's own archive, open-access literature (CORE) and
// published abstracts (OpenAlex) — not paywalled papers, books, student work or most of the web.
//
// PLAGIARISM_OPEN_SOURCES (default "local,core,openalex") picks the sources. Every enabled
// source MUST succeed: a failed source throws ProviderError (retry, then manual review) rather
// than quietly producing a lower score.
//
// Score = share of the manuscript's fingerprints found in any source (union), so the same
// passage found in two places counts once. The abstract near-duplicate flag is separate
// because duplicate publication matters even when the body differs.

const VERSION = "open-1";
const ABSTRACT_DUPLICATE_AT = 0.5;

registerPlagiarismProvider("open", () => ({
  async check({ fullText, title, manuscriptId, abstract }) {
    const sources = (process.env.PLAGIARISM_OPEN_SOURCES || "local,core,openalex").split(",").map((s) => s.trim());
    const { entries, wordCount } = fingerprint(fullText);
    if (wordCount < 150) throw new ProviderError("open-similarity", "text too short to check");

    const covered = new Set();
    const matches = [];
    const flags = [];
    const coverage = { version: VERSION, sources: {} };
    const note = (s, entriesHit) => entriesHit.forEach((e) => covered.add(e.h));

    if (sources.includes("local")) {
      const local = await findLocalOverlaps(entries, { excludeManuscriptId: manuscriptId });
      note("local", local.matched);
      coverage.sources.local = { documents_compared: "IJSDS archive", overlapping: local.docs.length };
      const passages = matchedPassages(fullText, local.matched, 3);
      local.docs.slice(0, 5).forEach((d, i) =>
        matches.push({
          // Never reveal another author's unpublished title.
          source_title: d.kind === "PUBLISHED" ? d.title ?? "Published IJSDS article" : "Another (unpublished) IJSDS submission",
          source_url: d.kind === "PUBLISHED" && d.articleId ? `/articles/${d.articleId}` : undefined,
          similarity_pct: Number((d.containment * 100).toFixed(1)),
          matched_snippet: passages[i] ?? passages[0] ?? "",
        }),
      );
    }

    if (sources.includes("core")) {
      const core = await checkCore(fullText, entries, { maxQueries: Number(process.env.PLAGIARISM_CORE_QUERIES) || 6 });
      for (const d of core.docs) for (const e of entries) if (d.set.has(e.h)) covered.add(e.h);
      coverage.sources.core = { passages_searched: core.queried, results_without_text: core.noText, overlapping: core.docs.length };
      core.docs.slice(0, 5).forEach((d) =>
        matches.push({
          source_title: d.source_title,
          source_url: d.source_url,
          similarity_pct: Number((d.containment * 100).toFixed(1)),
          matched_snippet: matchedPassages(fullText, entries.filter((e) => d.set.has(e.h)), 1)[0] ?? "",
        }),
      );
    }

    if (sources.includes("openalex")) {
      const oa = await checkOpenAlexAbstract(title, abstract ?? "");
      coverage.sources.openalex = oa.skipped ? { skipped: oa.skipped } : { abstracts_compared: "top OpenAlex title matches", overlapping: oa.docs.length };
      for (const d of oa.docs) {
        matches.push({ source_title: d.source_title, source_url: d.source_url, similarity_pct: Number((d.containment * 100).toFixed(1)), matched_snippet: "Abstract overlap" });
        if (d.containment >= ABSTRACT_DUPLICATE_AT) flags.push("ABSTRACT_NEAR_DUPLICATE");
      }
    }

    matches.sort((a, b) => b.similarity_pct - a.similarity_pct);
    return {
      provider: `IJSDS open similarity check (${VERSION}, partial coverage)`,
      requestId: null,
      score: Number((covered.size / entries.length).toFixed(5)),
      matches: matches.slice(0, 10),
      flags: [...new Set(flags)],
      coverage,
    };
  },
}));
