import prisma from "../../config/prisma.js";
import sendEmail from "../email/email.service.js";
import { createNotification } from "../notifications/notifications.service.js";

const FREE_MAIL_RE =
  /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|zoho|yandex)\.[a-z.]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const GOOGLE_SCHOLAR_RE = /^https?:\/\/scholar\.google\.[a-z.]+\//i;
const RESEARCHGATE_RE = /^https?:\/\/([a-z0-9-]+\.)*researchgate\.net\//i;
const SETUP_ASSISTANCE_FEE_KOBO = 500000; // ₦5,000
const PAYSTACK_BASE = "https://api.paystack.co";

export const isInstitutionalEmail = (email) => {
  const val = String(email ?? "").trim();
  return EMAIL_RE.test(val) && !FREE_MAIL_RE.test(val);
};

export const evaluateProfileVerification = (profile) => {
  const hasInstitutionalEmail =
    isInstitutionalEmail(profile?.institutional_email) || isInstitutionalEmail(profile?.email);
  const hasOrcid = ORCID_RE.test(String(profile?.orcid_id ?? "").trim());
  const hasGoogleScholar = GOOGLE_SCHOLAR_RE.test(String(profile?.google_scholar_url ?? "").trim());
  const hasResearchGate = RESEARCHGATE_RE.test(String(profile?.researchgate_url ?? "").trim());
  return {
    is_verified: hasInstitutionalEmail && hasOrcid && hasGoogleScholar && hasResearchGate,
    checks: {
      institutional_email: hasInstitutionalEmail,
      orcid_id: hasOrcid,
      google_scholar_url: hasGoogleScholar,
      researchgate_url: hasResearchGate,
    },
  };
};

const attachVerification = (profile) =>
  profile ? { ...profile, is_verified: evaluateProfileVerification(profile).is_verified } : profile;

export const getProfile = async (id) => {
  const profile = await prisma.profile.findUnique({
    where: { id },
    select: {
      id: true,
      full_name: true,
      email: true,
      institutional_email: true,
      affiliation: true,
      orcid_id: true,
      google_scholar_url: true,
      researchgate_url: true,
      bio: true,
      role: true,
      is_editor: true,
      is_reviewer: true,
      is_admin: true,
      email_notifications_enabled: true,
      deadline_reminder_days: true,
      request_reviewer: true,
      request_editor: true,
      request_admin: true,
      created_at: true,
      updated_at: true,
    },
  });

  if (!profile) {
    const err = new Error("Profile not found");
    err.status = 404;
    throw err;
  }

  return attachVerification(profile);
};

export const updateProfile = async (id, data, { userId, role }) => {
  // Users can only update their own profile unless they are admin
  if (id !== userId && role !== "admin") {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) {
    const err = new Error("Profile not found");
    err.status = 404;
    throw err;
  }

  const {
    full_name, affiliation, bio, orcid_id,
    institutional_email, google_scholar_url, researchgate_url,
    email_notifications_enabled, deadline_reminder_days,
    request_reviewer, request_editor, request_admin,
  } = data;

  const updateData = {};
  if (full_name !== undefined) updateData.full_name = full_name;
  if (affiliation !== undefined) updateData.affiliation = affiliation;
  if (bio !== undefined) updateData.bio = bio;
  if (orcid_id !== undefined) {
    const trimmed = String(orcid_id ?? "").trim();
    if (trimmed && !ORCID_RE.test(trimmed)) {
      const err = new Error("Invalid ORCID iD. Use the format 0000-0000-0000-0000.");
      err.status = 400;
      throw err;
    }
    updateData.orcid_id = trimmed || null;
  }
  if (institutional_email !== undefined) {
    const trimmed = String(institutional_email ?? "").trim().toLowerCase();
    if (trimmed && !isInstitutionalEmail(trimmed)) {
      const err = new Error("Please enter a valid institutional email (not a personal Gmail/Yahoo/Outlook address).");
      err.status = 400;
      throw err;
    }
    updateData.institutional_email = trimmed || null;
  }
  if (google_scholar_url !== undefined) {
    const trimmed = String(google_scholar_url ?? "").trim();
    if (trimmed && !GOOGLE_SCHOLAR_RE.test(trimmed)) {
      const err = new Error("Please enter a valid Google Scholar profile URL (https://scholar.google.com/citations?user=…).");
      err.status = 400;
      throw err;
    }
    updateData.google_scholar_url = trimmed || null;
  }
  if (researchgate_url !== undefined) {
    const trimmed = String(researchgate_url ?? "").trim();
    if (trimmed && !RESEARCHGATE_RE.test(trimmed)) {
      const err = new Error("Please enter a valid ResearchGate profile URL (https://www.researchgate.net/profile/…).");
      err.status = 400;
      throw err;
    }
    updateData.researchgate_url = trimmed || null;
  }
  if (email_notifications_enabled !== undefined) updateData.email_notifications_enabled = email_notifications_enabled;
  if (deadline_reminder_days !== undefined) updateData.deadline_reminder_days = deadline_reminder_days;
  // Becoming a reviewer goes through the application form (POST /api/reviewer-applications);
  // a user may withdraw (false) but not open a request without submitting their details.
  if (request_reviewer !== undefined) {
    if (request_reviewer === true && role !== "admin") {
      const err = new Error("Please apply through the reviewer application form.");
      err.status = 400;
      throw err;
    }
    updateData.request_reviewer = request_reviewer;
  }
  // Editor and admin access is assigned by administrators, never requested. Clearing stays
  // allowed so older pending requests can still be declined or withdrawn.
  if (request_editor === true || request_admin === true) {
    const err = new Error("Editor and administrator access is assigned by the journal's administrators and cannot be requested.");
    err.status = 403;
    throw err;
  }
  if (request_editor !== undefined) updateData.request_editor = request_editor;
  if (request_admin !== undefined) updateData.request_admin = request_admin;

  // Admin-only fields
  if (role === "admin") {
    if (data.is_editor !== undefined) updateData.is_editor = data.is_editor;
    if (data.is_reviewer !== undefined) updateData.is_reviewer = data.is_reviewer;
    if (data.is_admin !== undefined) updateData.is_admin = data.is_admin;
    // The role column changes ONLY through an explicit assign_role. The frontend used to inject
    // the caller's own role ("admin") into every request body, so reading data.role here made
    // every user an admin whenever an admin approved or declined their role request.
    if (data.assign_role !== undefined) {
      const allowed = ["author", "reviewer", "editor", "admin"];
      if (!allowed.includes(data.assign_role)) {
        const err = new Error(`assign_role must be one of ${allowed.join(", ")}`);
        err.status = 400;
        throw err;
      }
      updateData.role = data.assign_role;
    }
  }

  const updated = await prisma.profile.update({
    where: { id },
    data: updateData,
    select: {
      id: true, full_name: true, email: true, institutional_email: true, affiliation: true,
      orcid_id: true, google_scholar_url: true, researchgate_url: true,
      bio: true, role: true, is_editor: true,
      is_reviewer: true, is_admin: true, email_notifications_enabled: true,
      deadline_reminder_days: true, request_reviewer: true,
      request_editor: true, request_admin: true, created_at: true, updated_at: true,
    },
  });

  // Role-request notifications happen here, where the change is made. (The browser used to send
  // these emails itself, which failed: authors may not call the editor-only send endpoint.)
  notifyRoleRequestChanges(profile, updated, { selfEdit: id === userId }).catch((e) =>
    console.error("[profiles] role-request notification failed:", e.message),
  );

  return attachVerification(updated);
};

export const listProfiles = async ({ role, is_reviewer, is_editor }) => {
  const where = {};
  if (role) where.role = role;
  if (is_reviewer !== undefined) where.is_reviewer = is_reviewer === "true";
  if (is_editor !== undefined) where.is_editor = is_editor === "true";

  const rows = await prisma.profile.findMany({
    where,
    select: {
      id: true, full_name: true, email: true, institutional_email: true, affiliation: true,
      orcid_id: true, google_scholar_url: true, researchgate_url: true,
      role: true, is_editor: true, is_reviewer: true,
      is_admin: true, request_reviewer: true, request_editor: true, request_admin: true,
    },
    orderBy: { full_name: "asc" },
  });

  return rows.map(attachVerification);
};

export const getMyProfileSetupRequests = async (profileId) =>
  prisma.profileSetupRequest.findMany({
    where: { profile_id: profileId },
    orderBy: { created_at: "desc" },
  });

const verifyPaystackSetupFee = async (reference) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY_LIVE;
  if (!secretKey) {
    const err = new Error("Payment verification is temporarily unavailable. Please contact support.");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secretKey}`,
    },
  });
  const json = await res.json();
  if (!json?.status || json?.data?.status !== "success") {
    const err = new Error("Paystack payment could not be verified. Please complete the ₦5,000 payment first.");
    err.status = 402;
    throw err;
  }
  if (json.data.currency !== "NGN" || Number(json.data.amount) < SETUP_ASSISTANCE_FEE_KOBO) {
    const err = new Error("Payment amount is below the required ₦5,000 account setup fee.");
    err.status = 402;
    throw err;
  }
  return json.data;
};

export const createProfileSetupRequest = async (profileId, payload) => {
  const fullName = String(payload?.full_name ?? "").trim();
  const contactEmail = String(payload?.contact_email ?? "").trim();
  const phone = String(payload?.phone ?? "").trim() || null;
  const affiliation = String(payload?.affiliation ?? "").trim() || null;
  const notes = String(payload?.notes ?? "").trim() || null;
  const paymentReference = String(payload?.payment_reference ?? "").trim();
  const allowedAccounts = new Set(["institutional_email", "orcid", "google_scholar", "researchgate"]);
  const accountsNeeded = Array.isArray(payload?.accounts_needed)
    ? [...new Set(payload.accounts_needed.filter((a) => allowedAccounts.has(a)))]
    : [];

  if (fullName.length < 2) {
    const err = new Error("Please enter your full name.");
    err.status = 400;
    throw err;
  }
  if (!EMAIL_RE.test(contactEmail)) {
    const err = new Error("Please enter a valid contact email address.");
    err.status = 400;
    throw err;
  }
  if (accountsNeeded.length === 0) {
    const err = new Error("Select at least one scholarly account you need help setting up.");
    err.status = 400;
    throw err;
  }
  if (!paymentReference) {
    const err = new Error("A verified ₦5,000 payment reference is required to submit this request.");
    err.status = 402;
    throw err;
  }

  const duplicate = await prisma.profileSetupRequest.findUnique({
    where: { payment_reference: paymentReference },
  });
  if (duplicate) {
    const err = new Error("This payment reference has already been used for a setup request.");
    err.status = 409;
    throw err;
  }

  await verifyPaystackSetupFee(paymentReference);

  const created = await prisma.profileSetupRequest.create({
    data: {
      profile_id: profileId,
      full_name: fullName,
      contact_email: contactEmail,
      phone,
      affiliation,
      accounts_needed: accountsNeeded,
      notes,
      payment_reference: paymentReference,
      amount_naira: 5000,
      status: "PAID",
    },
  });

  // Notify admins (fire-and-forget)
  prisma.profile
    .findMany({
      where: { OR: [{ is_admin: true }, { role: "admin" }] },
      select: { id: true, email: true, full_name: true },
    })
    .then((admins) => {
      for (const a of admins) {
        createNotification({
          user_id: a.id,
          title: "New Paid Account Setup Request (₦5,000)",
          message: `${fullName} (${contactEmail}) paid ₦5,000 for help setting up: ${accountsNeeded.join(", ")}. Ref: ${paymentReference}`,
          type: "info",
        }).catch(() => {});
      }
    })
    .catch(() => {});

  return created;
};

const ROLE_REQUESTS = [
  // Reviewer requests are announced by the application flow; this only sends decisions for them.
  { request: "request_reviewer", flag: "is_reviewer", label: "Reviewer", announce: false },
  { request: "request_editor", flag: "is_editor", label: "Editor" },
  { request: "request_admin", flag: "is_admin", label: "Administrator" },
];

const notifyRoleRequestChanges = async (before, after, { selfEdit }) => {
  for (const r of ROLE_REQUESTS) {
    const opened = !before[r.request] && after[r.request];
    const closed = before[r.request] && !after[r.request];

    if (opened && selfEdit && r.announce !== false) {
      const admins = await prisma.profile.findMany({
        where: { OR: [{ is_admin: true }, { role: "admin" }] },
        select: { id: true, email: true, full_name: true },
      });
      for (const a of admins) {
        createNotification({ user_id: a.id, title: `New ${r.label} role request`, message: `${after.full_name ?? after.email} requested ${r.label} access.`, type: "info" }).catch(() => {});
        if (a.email) {
          sendEmail("role_request_admin", { to: a.email, recipientId: a.id, name: a.full_name ?? "Admin", requesterName: after.full_name ?? "A user", requesterEmail: after.email ?? "", roleLabel: r.label }).catch(() => {});
        }
      }
    }

    if (closed && !selfEdit) {
      const approved = Boolean(after[r.flag]);
      createNotification({ user_id: after.id, title: `${r.label} request ${approved ? "approved" : "declined"}`, message: approved ? `You now have ${r.label} access.` : `Your ${r.label} request was declined.`, type: approved ? "success" : "info" }).catch(() => {});
      if (after.email) {
        sendEmail("role_request_decision", { to: after.email, recipientId: after.id, name: after.full_name ?? "there", roleLabel: r.label, approved }).catch(() => {});
      }
    }
  }
};
