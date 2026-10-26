import prisma from "../../config/prisma.js";
import sendEmail from "../email/email.service.js";
import { createNotification } from "../notifications/notifications.service.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Validation ──────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Free mailboxes can't show institutional affiliation.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com",
  "mail.com", "zoho.com", "yandex.com",
]);

/** ORCID iD: 0000-0000-0000-000X with a valid ISO 7064 MOD 11-2 check digit. */
export const normaliseOrcid = (raw) => {
  const m = String(raw ?? "").trim().match(/(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dXx])$/);
  if (!m) return null;
  const digits = (m[1] + m[2] + m[3] + m[4]).toUpperCase();
  let total = 0;
  for (const ch of digits.slice(0, 15)) total = (total + Number(ch)) * 2;
  const check = (12 - (total % 11)) % 11;
  const expected = check === 10 ? "X" : String(check);
  if (digits[15] !== expected) return null;
  return `${m[1]}-${m[2]}-${m[3]}-${m[4].toUpperCase()}`;
};

const urlOn = (raw, hostTest) => {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (!/^https?:$/.test(u.protocol) || !hostTest(u.hostname.toLowerCase())) return null;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
};

export const validateApplication = (body) => {
  const errors = {};
  const full_name = String(body?.full_name ?? "").replace(/\s+/g, " ").trim();
  if (full_name.length < 3) errors.full_name = "Enter your full name.";

  const institutional_email = String(body?.institutional_email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(institutional_email)) errors.institutional_email = "Enter a valid email address.";
  else if (FREE_MAIL.has(institutional_email.split("@")[1])) errors.institutional_email = "Use your institutional email (not a personal Gmail, Yahoo, Outlook, etc.).";

  const orcid_id = normaliseOrcid(body?.orcid_id);
  if (!orcid_id) errors.orcid_id = "Enter a valid ORCID iD, e.g. 0000-0002-1825-0097.";

  const researchgate_url = urlOn(body?.researchgate_url, (h) => h === "researchgate.net" || h.endsWith(".researchgate.net"));
  if (!researchgate_url) errors.researchgate_url = "Enter your ResearchGate profile link (https://www.researchgate.net/profile/...).";

  const google_scholar_url = urlOn(body?.google_scholar_url, (h) => /^scholar\.google\.[a-z.]+$/.test(h));
  if (!google_scholar_url) errors.google_scholar_url = "Enter your Google Scholar profile link (https://scholar.google.com/citations?user=...).";

  if (Object.keys(errors).length) {
    const err = httpError(400, Object.values(errors)[0]);
    err.fields = errors;
    throw err;
  }
  return { full_name, institutional_email, orcid_id, researchgate_url, google_scholar_url };
};

// ── Applicant ───────────────────────────────────────────────────────────────────────

export const submitApplication = async (userId, body) => {
  const data = validateApplication(body);
  const profile = await prisma.profile.findUnique({
    where: { id: userId },
    select: { id: true, email: true, full_name: true, is_reviewer: true, orcid_id: true },
  });
  if (!profile) throw httpError(404, "Profile not found");
  if (profile.is_reviewer) throw httpError(409, "You are already a reviewer.");

  let app;
  try {
    app = await prisma.$transaction(async (tx) => {
      const created = await tx.reviewerApplication.create({ data: { profile_id: userId, ...data } });
      await tx.profile.update({
        where: { id: userId },
        data: { request_reviewer: true, ...(profile.orcid_id ? {} : { orcid_id: data.orcid_id }) },
      });
      return created;
    });
  } catch (e) {
    if (e.code === "P2002") throw httpError(409, "You already have an application under review.");
    throw e;
  }

  const submittedOn = app.created_at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const mail = {
    name: data.full_name,
    institutionalEmail: data.institutional_email,
    orcid: data.orcid_id,
    researchgateUrl: data.researchgate_url,
    scholarUrl: data.google_scholar_url,
    submittedOn,
  };
  // Acknowledgement to the account email, and to the institutional address if different.
  const recipients = [...new Set([profile.email, data.institutional_email].filter(Boolean).map((e) => e.toLowerCase()))];
  for (const to of recipients) {
    sendEmail("reviewer_application_received", { ...mail, to, recipientId: userId }).catch((e) =>
      console.error("[reviewer-app] acknowledgement email failed:", e.message),
    );
  }
  createNotification({
    user_id: userId,
    title: "Reviewer application received",
    message: "Your reviewer application is under review. We'll email you when a decision is made.",
    type: "info",
  }).catch(() => {});

  const admins = await prisma.profile.findMany({ where: { OR: [{ is_admin: true }, { role: "admin" }] }, select: { id: true, email: true, full_name: true } });
  for (const a of admins) {
    createNotification({ user_id: a.id, title: "New reviewer application", message: `${data.full_name} applied to become a reviewer.`, type: "info" }).catch(() => {});
    if (a.email) {
      sendEmail("reviewer_application_admin", {
        to: a.email, recipientId: a.id, name: a.full_name ?? "Admin", applicantName: data.full_name, accountEmail: profile.email ?? "",
        institutionalEmail: data.institutional_email, orcid: data.orcid_id, researchgateUrl: data.researchgate_url, scholarUrl: data.google_scholar_url,
      }).catch(() => {});
    }
  }
  return app;
};

export const myApplications = (userId) =>
  prisma.reviewerApplication.findMany({
    where: { profile_id: userId },
    orderBy: { created_at: "desc" },
    take: 10,
    select: { id: true, status: true, decision_reason: true, created_at: true, decided_at: true },
  });

// ── Admin ───────────────────────────────────────────────────────────────────────────

export const listApplications = (status = "PENDING") =>
  prisma.reviewerApplication.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { created_at: "asc" },
    take: 200,
    include: { applicant: { select: { id: true, email: true, affiliation: true } } },
  });

export const decideApplication = async (id, { approve, reason }, admin) => {
  if (typeof approve !== "boolean") throw httpError(400, "approve must be true or false");
  const cleanReason = String(reason ?? "").trim() || null;

  const app = await prisma.$transaction(async (tx) => {
    const claimed = await tx.reviewerApplication.updateMany({
      where: { id, status: "PENDING" },
      data: { status: approve ? "APPROVED" : "DECLINED", decided_by: admin.id, decided_at: new Date(), decision_reason: cleanReason },
    });
    if (claimed.count !== 1) throw httpError(409, "Application not found or already decided");
    const row = await tx.reviewerApplication.findUnique({ where: { id }, include: { applicant: { select: { id: true, email: true } } } });
    await tx.profile.update({
      where: { id: row.profile_id },
      data: { request_reviewer: false, ...(approve ? { is_reviewer: true } : {}) },
    });
    return row;
  });

  createNotification({
    user_id: app.profile_id,
    title: `Reviewer application ${approve ? "approved" : "declined"}`,
    message: approve ? "You are now a reviewer for IJSDS." : `Your reviewer application was declined.${cleanReason ? ` Reason: ${cleanReason}` : ""}`,
    type: approve ? "success" : "info",
  }).catch(() => {});
  if (app.applicant?.email) {
    sendEmail("role_request_decision", { to: app.applicant.email, recipientId: app.profile_id, name: app.full_name, roleLabel: "Reviewer", approved: approve, reason: cleanReason ?? undefined }).catch((e) =>
      console.error("[reviewer-app] decision email failed:", e.message),
    );
  }
  return { id: app.id, status: app.status };
};
