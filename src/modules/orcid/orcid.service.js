import jwt from "jsonwebtoken";
import prisma from "../../config/prisma.js";
import sendWelcomeEmail from "../email/email.service.js";

const ORCID_REDIRECT_URI =
  "https://ijsdsbackend-agewf0h8g5hfawax.switzerlandnorth-01.azurewebsites.net/auth/orcid";

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
  });

  return response.json();
};

export const fetchOrcidProfile = async ({ orcid, access_token }) => {
  const response = await fetch(`https://pub.orcid.org/v3.0/${orcid}/person`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  return response.json();
};

export const authenticateOrcidUser = async (name, email, orcid) => {
  let profile = await prisma.profile.findUnique({ where: { email } });

  if (profile) {
    // Update ORCID ID on existing profile
    profile = await prisma.profile.update({
      where: { id: profile.id },
      data: { orcid_id: orcid },
    });
  } else {
    // Create new profile — no password (ORCID-only account)
    profile = await prisma.profile.create({
      data: { full_name: name, email, orcid_id: orcid, role: "author" },
    });

    await sendWelcomeEmail({ name, to: email });
  }

  const token = jwt.sign(
    { id: profile.id, email: profile.email, role: profile.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" }
  );

  return { token, profile };
};
