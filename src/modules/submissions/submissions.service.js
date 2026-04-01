import prisma from "../../config/prisma.js";

export const listSubmissions = async ({
  userId,
  role,
  status,
  submissionType,
}) => {
  const where = {};

  // Authors only see their own submissions; editors/admins see all
  if (role === "author") where.submitter_id = userId;
  if (status) where.status = status;
  if (submissionType) where.submission_type = submissionType;

  return prisma.submission.findMany({
    where,
    include: {
      article: {
        select: {
          id: true,
          title: true,
          status: true,
          doi: true,
          subject_area: true,
        },
      },
      submitter: {
        select: { id: true, full_name: true, email: true, affiliation: true },
      },
    },
    orderBy: { submitted_at: "desc" },
  });
};

export const getSubmission = async (id, { userId, role }) => {
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      article: true,
      submitter: {
        select: { id: true, full_name: true, email: true, affiliation: true },
      },
      reviews: {
        select: {
          id: true,
          reviewer_id: true,
          invitation_status: true,
          recommendation: true,
          submitted_at: true,
          deadline_date: true,
          review_round: true,
        },
      },
      discussion_threads: {
        include: { messages: true },
      },
    },
  });

  if (!submission) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  // Authors can only view their own
  if (role === "author" && submission.submitter_id !== userId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  return submission;
};

export const createSubmission = async (data, userId, manuscript_file_url = null) => {
  const {
    title,
    abstract,
    keywords,
    authors,
    corresponding_author_email,
    subject_area,
    funding_info,
    conflicts_of_interest,
    cover_letter,
    reviewer_suggestions,
    submission_type,
  } = data;

  // Create article and submission in one transaction
  return prisma.$transaction(async (tx) => {
    const article = await tx.article.create({
      data: {
        title,
        abstract,
        keywords: keywords ?? [],
        authors,
        corresponding_author_email,
        manuscript_file_url,
        subject_area,
        funding_info,
        conflicts_of_interest,
        status: "submitted",
      },
    });

    const submission = await tx.submission.create({
      data: {
        article_id: article.id,
        submitter_id: userId,
        submission_type: submission_type ?? "new",
        cover_letter,
        reviewer_suggestions,
        status: "submitted",
      },
      include: {
        article: true,
        submitter: { select: { id: true, full_name: true, email: true } },
      },
    });

    return submission;
  });
};

export const updateSubmission = async (id, data, { userId, role }) => {
  const submission = await prisma.submission.findUnique({ where: { id } });

  if (!submission) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  // Authors can only update their own, and only limited fields
  if (role === "author") {
    if (submission.submitter_id !== userId) {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
    // Authors may only update cover letter / reviewer suggestions pre-review
    const { cover_letter, reviewer_suggestions } = data;
    return prisma.submission.update({
      where: { id },
      data: { cover_letter, reviewer_suggestions },
    });
  }

  // Editors / admins can update any field
  const {
    status,
    editor_notes,
    approved_by_editor,
    vetting_fee,
    processing_fee,
  } = data;

  const updateData = {};
  if (status) updateData.status = status;
  if (editor_notes !== undefined) updateData.editor_notes = editor_notes;
  if (approved_by_editor !== undefined) {
    updateData.approved_by_editor = approved_by_editor;
    if (approved_by_editor) {
      updateData.approved_at = new Date();
      updateData.approved_by = userId;
    }
  }
  if (vetting_fee !== undefined) updateData.vetting_fee = vetting_fee;
  if (processing_fee !== undefined) updateData.processing_fee = processing_fee;

  // Log status transition to audit trail
  if (status && status !== submission.status) {
    await prisma.workflowAuditLog.create({
      data: {
        submission_id: id,
        old_status: submission.status,
        new_status: status,
        changed_by: userId,
        change_reason: data.change_reason ?? null,
      },
    });
  }

  return prisma.submission.update({
    where: { id },
    data: updateData,
    include: {
      article: { select: { id: true, title: true, status: true } },
    },
  });
};
