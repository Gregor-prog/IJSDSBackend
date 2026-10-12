import { ProviderError } from "./citations.service.js";

// OpenAI-compatible embeddings client (POST {EMBEDDINGS_API_URL} -> { data: [{ embedding }] }).
// The schema's vector columns are 1536-d, so EMBEDDINGS_MODEL must produce 1536 dimensions.
// When unset, isConfigured() is false and callers fall back to keyword matching.

export const isConfigured = () => Boolean(process.env.EMBEDDINGS_API_URL);

export const embed = async (text) => {
  const url = process.env.EMBEDDINGS_API_URL;
  if (!url) throw new ProviderError("embeddings", "EMBEDDINGS_API_URL not set");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.EMBEDDINGS_API_KEY ? { Authorization: `Bearer ${process.env.EMBEDDINGS_API_KEY}` } : {}) },
      body: JSON.stringify({ model: process.env.EMBEDDINGS_MODEL, input: text.slice(0, 24000) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError("embeddings", e.message);
  }
  if (!res.ok) throw new ProviderError("embeddings", `HTTP ${res.status}`);
  const v = (await res.json())?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== 1536 || !v.every(Number.isFinite)) throw new ProviderError("embeddings", "expected a 1536-dimension vector");
  return v;
};

export const toPgVector = (v) => `[${v.join(",")}]`;
