import { registerPlagiarismProvider, registerAiProvider } from "./registry.js";
import { ProviderError } from "../citations.service.js";

// Vendor-neutral HTTP adapters. Point them at any service (or a thin proxy in front of a
// vendor) that follows this contract, then set PLAGIARISM_PROVIDER=http / AI_DETECTION_PROVIDER=http.
//
//  POST {PLAGIARISM_API_URL}   Authorization: Bearer {PLAGIARISM_API_KEY}
//    body    { "text": "...", "title": "..." }
//    returns { "score": 0..1, "requestId": "...", "matches": [{ "source_title", "source_url?", "similarity_pct", "matched_snippet" }] }
//
//  POST {AI_DETECTION_API_URL}  Authorization: Bearer {AI_DETECTION_API_KEY}
//    body    { "text": "...", "title": "..." }
//    returns { "score": 0..1, "modelVersion": "...", "requestId": "...", "flaggedSegments": [{ "segment_index", "text_snippet", "confidence", "label" }] }
//
// Responses are validated strictly: anything malformed throws ProviderError, which retries and
// finally routes the audit to manual review. A bad vendor response can never read as "clean".
// Only the manuscript body (bibliography excluded) is sent — data minimisation.

const TIMEOUT_MS = 60_000;

const post = async (provider, url, key, body) => {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(provider, e.message);
  }
  if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`);
  return res.json().catch(() => {
    throw new ProviderError(provider, "response was not JSON");
  });
};

const unit = (provider, v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new ProviderError(provider, "score missing or outside [0,1]");
  return v;
};

registerPlagiarismProvider("http", () => ({
  async check({ fullText, title }) {
    const url = process.env.PLAGIARISM_API_URL;
    if (!url) throw new ProviderError("plagiarism-http", "PLAGIARISM_API_URL not set");
    const j = await post("plagiarism-http", url, process.env.PLAGIARISM_API_KEY, { text: fullText, title });
    return {
      provider: process.env.PLAGIARISM_PROVIDER_LABEL || "plagiarism-http",
      requestId: j.requestId ?? null,
      score: unit("plagiarism-http", j.score),
      matches: Array.isArray(j.matches) ? j.matches.slice(0, 50) : [],
    };
  },
}));

registerAiProvider("http", () => ({
  async score({ fullText, title }) {
    const url = process.env.AI_DETECTION_API_URL;
    if (!url) throw new ProviderError("ai-http", "AI_DETECTION_API_URL not set");
    const j = await post("ai-http", url, process.env.AI_DETECTION_API_KEY, { text: fullText, title });
    if (!j.modelVersion) throw new ProviderError("ai-http", "modelVersion missing (results must be versioned)");
    return {
      provider: process.env.AI_DETECTION_PROVIDER_LABEL || "ai-http",
      modelVersion: String(j.modelVersion),
      requestId: j.requestId ?? null,
      score: unit("ai-http", j.score),
      flaggedSegments: Array.isArray(j.flaggedSegments) ? j.flaggedSegments.slice(0, 50) : [],
    };
  },
}));
