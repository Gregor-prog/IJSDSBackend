import crypto from "node:crypto";

/**
 * Authenticates the AI blog writer (a custom GPT in ChatGPT) by the x-agent-key header,
 * matched against AGENT_BLOG_KEY. The key opens only the /api/agent/blog routes. Fails
 * closed: when the env var is missing or shorter than 32 characters, every request gets 503.
 */
export function requireAgentKey(req, res, next) {
  const expected = process.env.AGENT_BLOG_KEY ?? "";
  if (expected.length < 32) {
    return res.status(503).json({ error: "AI blog access is not configured" });
  }
  const given = req.get("x-agent-key");
  if (!given) return res.status(401).json({ error: "x-agent-key header required" });

  // Hash both sides so the comparison is constant-time whatever the length.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Invalid agent key" });
  return next();
}

/**
 * Fixed-window limit per process, so a leaked key can't flood the blog. Each Azure instance
 * counts separately, which is fine at this scale.
 */
export function rateLimit({ limit, windowMs, now = () => Date.now() }) {
  let windowStart = 0;
  let count = 0;
  return (req, res, next) => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (++count > limit) {
      res.set("Retry-After", String(Math.ceil((windowStart + windowMs - t) / 1000)));
      return res.status(429).json({ error: `Too many requests: at most ${limit} per hour` });
    }
    return next();
  };
}
