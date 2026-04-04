import prisma from "../../config/prisma.js";

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
  if (request_reviewer !== undefined) updateData.request_reviewer = request_reviewer;
  if (request_editor !== undefined) updateData.request_editor = request_editor;
  if (request_admin !== undefined) updateData.request_admin = request_admin;

  // Admin-only fields
  if (role === "admin") {
    if (data.is_editor !== undefined) updateData.is_editor = data.is_editor;
    if (data.is_reviewer !== undefined) updateData.is_reviewer = data.is_reviewer;
    if (data.is_admin !== undefined) updateData.is_admin = data.is_admin;
    if (data.role !== undefined) updateData.role = data.role;
  }

  return prisma.profile.update({
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
