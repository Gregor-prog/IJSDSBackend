import { registerPlagiarismProvider, registerAiProvider } from "./registry.js";

// DEVELOPMENT STAND-INS ONLY. These do not compare against any corpus and are not
// evidence of originality or authorship. They exist so the pipeline can be exercised end
// to end locally. Every result is stamped provider "heuristic-dev".

const stripBibliography = (text) => text.split(/\n\s*(?:references|bibliography|works cited)\s*\n/i)[0];

registerPlagiarismProvider("heuristic-dev", () => ({
  async check({ fullText }) {
    const body = stripBibliography(fullText || "");
    const words = body.toLowerCase().split(/\s+/).filter(Boolean);
    // Repeated 8-grams inside the document itself (copy/paste within the manuscript).
    const grams = new Map();
    for (let i = 0; i + 8 <= words.length; i++) {
      const g = words.slice(i, i + 8).join(" ");
      grams.set(g, (grams.get(g) ?? 0) + 1);
    }
    let dup = 0;
    const matches = [];
    for (const [g, n] of grams) {
      if (n > 1) {
        dup += (n - 1) * 8;
        if (matches.length < 10) {
          matches.push({ source_title: "Self-overlap (same manuscript)", similarity_pct: 0, matched_snippet: g });
        }
      }
    }
    const score = words.length ? Math.min(dup / words.length, 1) : 0;
    return { provider: "heuristic-dev", requestId: null, score: Number(score.toFixed(5)), matches };
  },
}));

registerAiProvider("heuristic-dev", () => ({
  async score({ fullText }) {
    const paragraphs = stripBibliography(fullText || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 50);
    const markers = [
      /delves? into the multifaceted/i,
      /it is important to note that/i,
      /underscores the paramount importance/i,
      /plays? a crucial role in shaping/i,
      /serves? as a testament to/i,
      /a myriad of factors/i,
    ];
    const flaggedSegments = [];
    paragraphs.forEach((p, i) => {
      const hits = markers.filter((m) => m.test(p)).length;
      if (hits) {
        flaggedSegments.push({ segment_index: i + 1, text_snippet: p.slice(0, 160), confidence: Math.min(0.4 + hits * 0.2, 0.9), label: "stock-phrase" });
      }
    });
    const score = paragraphs.length ? Math.min(flaggedSegments.length / paragraphs.length, 1) : 0;
    return { provider: "heuristic-dev", modelVersion: "heuristic-dev-1", requestId: null, score: Number(score.toFixed(5)), flaggedSegments };
  },
}));
