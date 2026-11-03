import crypto from "node:crypto";

/**
 * Authenticates the Parakletus admin console (admin.parakletushub.com), a
 * server-to-server caller, by the x-console-token header matched against
 * ADMIN_CONSOLE_TOKEN. Fails closed: when the env var is missing or shorter
 * than 32 characters, every request gets 503.
 */
export function requireConsoleToken(req, res, next) {
  const expected = process.env.ADMIN_CONSOLE_TOKEN ?? "";
  if (expected.length < 32) {
    return res.status(503).json({ error: "Console access is not configured" });
  }
  const given = req.get("x-console-token");
  if (!given) return res.status(401).json({ error: "Console token required" });

  // Hash both sides so the comparison is constant-time whatever the length.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Invalid console token" });
  return next();
}
