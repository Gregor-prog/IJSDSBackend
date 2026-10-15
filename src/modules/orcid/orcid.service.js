import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../../config/prisma.js";
import sendWelcomeEmail from "../email/email.service.js";

// The redirect URI sent to ORCID must be byte-identical in the authorize step and the token
// exchange, and must be registered in the ORCID app. Both steps are now built here.
const BACKEND_URL = (process.env.BACKEND_URL || "https://ijsds-database-ftb5hpfrfecegtbz.switzerlandnorth-01.azurewebsites.net").replace(/\/$/, "");
export const ORCID_REDIRECT_URI = process.env.ORCID_REDIRECT_URI || `${BACKEND_URL}/auth/orcid`;

export const newState = () => crypto.randomBytes(24).toString("hex");

export const authorizeUrl = (state) =>
  `https://orcid.org/oauth/authorize?${new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    response_type: "code",
    scope: "/authenticate",
    redirect_uri: ORCID_REDIRECT_URI,
    state,
  })}`;

export const exchangeCodeForToken = async (code) => {
  const response = await fetch("https://orcid.org/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: ORCID_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  return response.json();
};

export const fetchOrcidProfile = async ({ orcid, access_token }) => {
  const response = await fetch(`https://pub.orcid.org/v3.0/${orcid}/person`, {
    headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  return response.json();
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Finds the account for an ORCID sign-in:
 *  1. an account already linked to this ORCID iD;
 *  2. otherwise an account with the same email, but ONLY if ORCID marks that email verified
 *     (an unverified email on someone's ORCID record must never log them into that account);
 *  3. otherwise a new author account.
 */
export const authenticateOrcidUser = async (name, emails, orcid) => {
  let profile = await prisma.profile.findFirst({ where: { orcid_id: orcid } });

  if (!profile) {
    const verified = (emails ?? []).filter((e) => e?.email && e.verified === true).map((e) => e.email.toLowerCase());
    if (!verified.length) {
      throw httpError(422, "Your ORCID record has no verified, visible email. Verify an email on ORCID (and make it visible), or sign in with your password.");
    }
    const existing = await prisma.profile.findFirst({ where: { email: { in: verified, mode: "insensitive" } } });
    if (existing) {
      if (existing.orcid_id && existing.orcid_id !== orcid) {
        throw httpError(409, "This account is already linked to a different ORCID iD.");
      }
      profile = await prisma.profile.update({ where: { id: existing.id }, data: { orcid_id: orcid } });
    } else {
      profile = await prisma.profile.create({
        data: { full_name: name, email: verified[0], orcid_id: orcid, role: "author" },
      });
      sendWelcomeEmail({ name, to: verified[0] }).catch((e) => console.error("[email] orcid welcome:", e.message));
    }
  }

  const token = jwt.sign(
    { id: profile.id, email: profile.email, role: profile.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" },
  );

  return { token, profile };
};
