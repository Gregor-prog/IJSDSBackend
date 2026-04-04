import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { sendWelcomeEmail } from "../email/email.service.js";
import sendEmail from "../email/email.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const signToken = (profile) =>
  jwt.sign(
    {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      is_admin: profile.is_admin,
      is_editor: profile.is_editor,
      is_reviewer: profile.is_reviewer,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "7d" },
  );

// ── In-memory token blocklist (logout) ───────────────────────────────────────
// Stores JTIs (or full tokens) of logged-out tokens until they expire.
// Replace with Redis for multi-instance deployments.
const blocklist = new Set();
export const blockToken = (token) => blocklist.add(token);
export const isBlocked = (token) => blocklist.has(token);

// ── Service functions ─────────────────────────────────────────────────────────

export const register = async ({ full_name, email, password }) => {
  const existing = await prisma.profile.findUnique({ where: { email } });
  if (existing) {
    const err = new Error("An account with this email already exists");
    err.status = 409;
    throw err;
  }

  const password_hash = await bcrypt.hash(password, 12);

  const profile = await prisma.profile.create({
    data: { full_name, email, password_hash, role: "author" },
  });

  await sendWelcomeEmail({ name: full_name, to: email });

  const token = signToken(profile);
  return { token, profile: sanitize(profile) };
};

export const login = async ({ email, password }) => {
  const profile = await prisma.profile.findUnique({ where: { email } });

  if (!profile || !profile.password_hash) {
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }

  const valid = await bcrypt.compare(password, profile.password_hash);
  if (!valid) {
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }

  const token = signToken(profile);
  return { token, profile: sanitize(profile) };
};

export const getMe = async (id) => {
  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  return sanitize(profile);
};

export const requestPasswordReset = async (email) => {
  const profile = await prisma.profile.findUnique({ where: { email } });
  // Always return success — don't reveal whether the email exists
  if (!profile) return;

  // Invalidate any existing unused tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: { profile_id: profile.id, used: false },
    data: { used: true },
  });

  const token = crypto.randomBytes(32).toString("hex");
  const expires_at = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

  await prisma.passwordResetToken.create({
    data: { profile_id: profile.id, token, expires_at },
  });

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

  await sendEmail("password_reset", {
    to: email,
    recipientId: profile.id,
    name: profile.full_name ?? "there",
    resetUrl,
  });
};

export const resetPassword = async (token, newPassword) => {
  const record = await prisma.passwordResetToken.findUnique({
    where: { token },
  });

  if (!record || record.used || record.expires_at < new Date()) {
    const err = new Error("Reset token is invalid or has expired");
    err.status = 400;
    throw err;
  }

  const password_hash = await bcrypt.hash(newPassword, 12);

  await prisma.profile.update({
    where: { id: record.profile_id },
    data: { password_hash },
  });

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { used: true },
  });
};

// ── Strip sensitive fields before sending to client ───────────────────────────
const sanitize = ({ password_hash, ...profile }) => profile;
