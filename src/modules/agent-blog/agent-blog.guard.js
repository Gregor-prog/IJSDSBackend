import crypto from "node:crypto";

/** Constant-time check of a presented key against an env var. null means not configured. */
export function keyMatchesEnv(envName, given) {
  const expected = process.env[envName] ?? "";
  if (expected.length < 32) return null;
  // Hash both sides so the comparison is constant-time whatever the length.
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Express guard for the x-agent-key header, matched against `envName`. Fails closed: when the
 * env var is missing or shorter than 32 characters, every request gets 503.
 */
export function requireKeyFrom(envName, label) {
  return (req, res, next) => {
    const given = req.get("x-agent-key");
    const ok = keyMatchesEnv(envName, given ?? "");
    if (ok === null) return res.status(503).json({ error: `${label} access is not configured` });
    if (!given) return res.status(401).json({ error: "x-agent-key header required" });
    if (!ok) return res.status(401).json({ error: "Invalid agent key" });
    return next();
  };
}

/** The AI blog writer's key (AGENT_BLOG_KEY) opens only the /api/agent/blog routes. */
export const requireAgentKey = requireKeyFrom("AGENT_BLOG_KEY", "AI blog");

/**
 * Fixed-window limit per process, so a leaked key can't flood the blog. Each Azure instance
 * counts separately, which is fine at this scale.
 */
export function makeCounter({ limit, windowMs, now = () => Date.now() }) {
  let windowStart = 0;
  let count = 0;
  const take = () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    return ++count <= limit;
  };
  take.retryAfterSeconds = () => Math.max(1, Math.ceil((windowStart + windowMs - now()) / 1000));
  return take;
}

export function rateLimit({ limit, ...opts }) {
  const take = makeCounter({ limit, ...opts });
  return (req, res, next) => {
    if (!take()) {
      res.set("Retry-After", String(take.retryAfterSeconds()));
      return res.status(429).json({ error: `Too many requests: at most ${limit} per hour` });
    }
    return next();
  };
}
