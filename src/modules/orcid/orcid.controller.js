import {
  newState,
  authorizeUrl,
  exchangeCodeForToken,
  fetchOrcidProfile,
  authenticateOrcidUser,
} from "./orcid.service.js";

const FRONTEND_URL = (process.env.FRONTEND_URL ?? "https://www.ijsds.org").replace(/\/$/, "");
const STATE_COOKIE = "orcid_state";

const readCookie = (req, name) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

const failTo = (res, message) =>
  res.redirect(`${FRONTEND_URL}/auth?error=${encodeURIComponent(message)}`);

/** GET /auth/orcid/start — sets a one-time state cookie and sends the browser to ORCID. */
export const orcidStart = (req, res) => {
  const state = newState();
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Path=/auth/orcid; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  );
  return res.redirect(authorizeUrl(state));
};

/** GET /auth/orcid — ORCID redirects back here with ?code&state. */
const orcidCallback = async (req, res) => {
  // One-time state: rejects login CSRF (someone else's ORCID code pushed into your browser).
  const expected = readCookie(req, STATE_COOKIE);
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=; Path=/auth/orcid; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  if (!expected || req.query.state !== expected) {
    return failTo(res, "ORCID sign-in expired or was not started from this browser. Please try again.");
  }
  if (!req.query.code) return failTo(res, "ORCID did not return an authorisation code.");

  try {
    const orcidData = await exchangeCodeForToken(req.query.code);
    if (!orcidData.orcid) return failTo(res, "ORCID sign-in failed. Please try again.");

    const orcidProfile = await fetchOrcidProfile(orcidData);
    const { token } = await authenticateOrcidUser(orcidData.name, orcidProfile.emails?.email, orcidData.orcid);

    // Token in the fragment, not the query: fragments aren't sent to servers or written to logs.
    return res.redirect(`${FRONTEND_URL}/auth/callback#token=${token}`);
  } catch (err) {
    console.error("[orcid] callback failed:", err.message);
    return failTo(res, err.status && err.status < 500 ? err.message : "ORCID sign-in failed. Please try again.");
  }
};

export default orcidCallback;
