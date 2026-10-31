import prisma from "../../config/prisma.js";
import sendEmail from "../email/email.service.js";
import { createNotification } from "../notifications/notifications.service.js";

export const getProfile = async (id) => {
  const profile = await prisma.profile.findUnique({
    where: { id },
    select: {
      id: true,
      full_name: true,
      email: true,
      affiliation: true,
      orcid_id: true,
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

  return profile;
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
    email_notifications_enabled, deadline_reminder_days,
    request_reviewer, request_editor, request_admin,
  } = data;

  const updateData = {};
  if (full_name !== undefined) updateData.full_name = full_name;
  if (affiliation !== undefined) updateData.affiliation = affiliation;
  if (bio !== undefined) updateData.bio = bio;
  if (orcid_id !== undefined) updateData.orcid_id = orcid_id;
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
      id: true, full_name: true, email: true, affiliation: true,
      orcid_id: true, bio: true, role: true, is_editor: true,
      is_reviewer: true, is_admin: true, email_notifications_enabled: true,
      deadline_reminder_days: true, request_reviewer: true,
      request_editor: true, request_admin: true, updated_at: true,
    },
  });

  // Role-request notifications happen here, where the change is made. (The browser used to send
  // these emails itself, which failed: authors may not call the editor-only send endpoint.)
  notifyRoleRequestChanges(profile, updated, { selfEdit: id === userId }).catch((e) =>
    console.error("[profiles] role-request notification failed:", e.message),
  );

  return updated;
};

export const listProfiles = async ({ role, is_reviewer, is_editor }) => {
  const where = {};
  if (role) where.role = role;
  if (is_reviewer !== undefined) where.is_reviewer = is_reviewer === "true";
  if (is_editor !== undefined) where.is_editor = is_editor === "true";

  return prisma.profile.findMany({
    where,
    select: {
      id: true, full_name: true, email: true, affiliation: true,
      orcid_id: true, role: true, is_editor: true, is_reviewer: true,
      is_admin: true, request_reviewer: true, request_editor: true, request_admin: true,
    },
    orderBy: { full_name: "asc" },
  });
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
