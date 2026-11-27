import { ProviderError } from "./citations.service.js";

// OpenAI-compatible embeddings client (POST {url} -> { data: [{ embedding }] }).
// Automatically uses OpenAI Paid API (`text-embedding-3-small`, 1536 dims) whenever
// `OPENAI_API_KEY` is configured, while still honoring explicit EMBEDDINGS_API_URL overrides.
// When neither is configured, isConfigured() is false and callers fall back to keyword matching.

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";

export const resolveEmbeddingsConfig = (env = process.env) => {
  if (env.EMBEDDINGS_API_URL) {
    return {
      url: env.EMBEDDINGS_API_URL,
      apiKey: env.EMBEDDINGS_API_KEY || env.OPENAI_API_KEY || null,
      model: env.EMBEDDINGS_MODEL || DEFAULT_OPENAI_EMBEDDINGS_MODEL,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      url: OPENAI_EMBEDDINGS_URL,
      apiKey: env.OPENAI_API_KEY,
      model: env.EMBEDDINGS_MODEL || DEFAULT_OPENAI_EMBEDDINGS_MODEL,
    };
  }
  return null;
};

export const isConfigured = (env = process.env) => Boolean(resolveEmbeddingsConfig(env));

export const embed = async (text, { fetchImpl = fetch, env = process.env } = {}) => {
  const cfg = resolveEmbeddingsConfig(env);
  if (!cfg) throw new ProviderError("embeddings", "OPENAI_API_KEY or EMBEDDINGS_API_URL not set");
  let res;
  try {
    res = await fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: String(text ?? "").slice(0, 24000) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProviderError("embeddings", e.message);
  }
  if (!res.ok) throw new ProviderError("embeddings", `HTTP ${res.status}`);
  const v = (await res.json())?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== 1536 || !v.every(Number.isFinite)) {
    throw new ProviderError("embeddings", "expected a 1536-dimension vector");
  }
  return v;
};

export const toPgVector = (v) => `[${v.join(",")}]`;
