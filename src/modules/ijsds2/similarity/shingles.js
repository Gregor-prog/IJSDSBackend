// Winnowing document fingerprints (Schleimer, Wilkerson, Aiken 2003): hash every K-word
// shingle, then keep the minimum hash in each window of W shingles. Two texts that share a
// run of at least K+W-1 words are guaranteed to share a fingerprint, while the stored
// fingerprint set stays ~2/(W+1) of the shingle count.

export const K = 7; // words per shingle (long enough to skip common academic phrasing)
export const W = 4; // winnowing window

export const words = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

// Two independent 32-bit FNV-1a passes packed into one 52-bit integer (safe as a JS number
// and as a Postgres BIGINT).
const hashWords = (ws, from) => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = from; i < from + K; i++) {
    const w = ws[i];
    for (let c = 0; c < w.length; c++) {
      const code = w.charCodeAt(c);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x20, 0x01000193) >>> 0; // word separator
    h2 = Math.imul(h2 ^ 0x20, 0x85ebca6b) >>> 0;
  }
  return h1 * 0x100000 + (h2 & 0xfffff);
};

/** @returns {{ entries: Array<{h:number,pos:number}>, wordCount:number }} pos = word index of the shingle start */
export const fingerprint = (text) => {
  const ws = words(text);
  if (ws.length < K) return { entries: [], wordCount: ws.length };
  const grams = [];
  for (let i = 0; i + K <= ws.length; i++) grams.push(hashWords(ws, i));

  const picked = new Map(); // pos -> hash (deduped by position)
  if (grams.length <= W) {
    let m = 0;
    for (let i = 1; i < grams.length; i++) if (grams[i] <= grams[m]) m = i;
    picked.set(m, grams[m]);
  } else {
    for (let i = 0; i + W <= grams.length; i++) {
      let m = i;
      for (let j = i + 1; j < i + W; j++) if (grams[j] <= grams[m]) m = j; // rightmost minimum
      picked.set(m, grams[m]);
    }
  }
  return { entries: [...picked].map(([pos, h]) => ({ h, pos })), wordCount: ws.length };
};

/** Fraction of the query's fingerprints that also occur in `docHashes` (containment). */
export const containment = (queryEntries, docHashSet) => {
  if (!queryEntries.length) return 0;
  let hit = 0;
  for (const e of queryEntries) if (docHashSet.has(e.h)) hit++;
  return hit / queryEntries.length;
};

/**
 * Turns matched fingerprint positions into readable passages of the *query* text:
 * adjacent matches are merged into runs, each run rendered from the normalised words.
 */
export const matchedPassages = (text, matchedEntries, max = 3) => {
  if (!matchedEntries.length) return [];
  const ws = words(text);
  const pos = matchedEntries.map((e) => e.pos).sort((a, b) => a - b);
  const runs = [];
  let start = pos[0];
  let end = pos[0] + K;
  for (const p of pos.slice(1)) {
    if (p <= end + W) end = Math.max(end, p + K);
    else {
      runs.push([start, end]);
      start = p;
      end = p + K;
    }
  }
  runs.push([start, end]);
  return runs
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
    .slice(0, max)
    .map(([a, b]) => `…${ws.slice(a, Math.min(b, a + 40)).join(" ")}${b - a > 40 ? " …" : "…"}`);
};
