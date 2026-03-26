import {
  exchangeCodeForToken,
  fetchOrcidProfile,
  authenticateOrcidUser,
} from "./orcid.service.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

const orcidCallback = async (req, res, next) => {
  try {
    const code = req.query.code;
    if (!code) {
      const err = new Error("Auth code not found");
      err.status = 400;
      throw err;
    }

    const orcidData = await exchangeCodeForToken(code);
    if (!orcidData.orcid) {
      const err = new Error("ORCID token exchange failed");
      err.status = 502;
      throw err;
    }

    const { orcid, name } = orcidData;
    const orcidProfile = await fetchOrcidProfile(orcidData);
    const email = orcidProfile.emails?.email?.[0]?.email;

    if (!email) {
      const err = new Error("No public email on ORCID profile");
      err.status = 422;
      throw err;
    }

    const { token } = await authenticateOrcidUser(name, email, orcid);

    // Redirect to frontend with JWT in query param — frontend stores it
    return res.redirect(`${FRONTEND_URL}/auth/callback?token=${token}`);
  } catch (err) {
    next(err);
  }
};

export default orcidCallback;
