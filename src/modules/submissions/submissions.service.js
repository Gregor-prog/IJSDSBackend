import prisma from "../../config/prisma.js";
import { sendSubmissionReceivedEmail, sendSubmissionAcceptedEmail } from "../email/email.service.js";

export const listSubmissions = async ({
  userId,
  role,
  is_editor,
  is_admin,
  status,
  submissionType,
}) => {
  const where = {};

  // Authors only see their own submissions; editors/admins see all
  const hasElevatedAccess = is_editor || is_admin || role === "editor" || role === "admin";
  if (!hasElevatedAccess) where.submitter_id = userId;
  if (status) where.status = status;
  if (submissionType) where.submission_type = submissionType;

  return prisma.submission.findMany({
    where,
    include: {
      article: {
        select: {
          id: true,
          title: true,
          abstract: true,
          status: true,
          doi: true,
          subject_area: true,
          authors: true,
          manuscript_file_url: true,
          vetting_fee: true,
          processing_fee: true,
        },
      },
      submitter: {
        select: { id: true, full_name: true, email: true, affiliation: true },
      },
    },
    orderBy: { submitted_at: "desc" },
  });
};

export const getSubmission = async (id, { userId, role, is_editor, is_admin, is_reviewer }) => {
  if (!id) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      article: {
        select: {
          id: true,
          title: true,
          abstract: true,
          keywords: true,
          authors: true,
          corresponding_author_email: true,
          manuscript_file_url: true,
          submission_date: true,
          publication_date: true,
          doi: true,
          crossrefDoi: true,
          status: true,
          volume: true,
          issue: true,
          page_start: true,
          page_end: true,
          subject_area: true,
          funding_info: true,
          conflicts_of_interest: true,
          vetting_fee: true,
          processing_fee: true,
          created_at: true,
          updated_at: true,
        },
      },
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

  const hasElevatedAccess = is_editor || is_admin || role === "editor" || role === "admin";
  // Reviewers may view submissions they are assigned to
  const hasReviewerAccess =
    (is_reviewer || role === "reviewer") &&
    submission.reviews.some((r) => r.reviewer_id === userId);

  if (!hasElevatedAccess && !hasReviewerAccess && submission.submitter_id !== userId) {
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
    // Standardizing data types (parsing string-encoded JSON fields from multipart forms)
    const parsedKeywords = typeof keywords === "string" ? JSON.parse(keywords) : (keywords ?? []);
    const parsedAuthors = typeof authors === "string" ? JSON.parse(authors) : authors;

    const article = await tx.article.create({
      data: {
        title,
        abstract,
        keywords: parsedKeywords,
        authors: parsedAuthors,
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
        article: {
          select: {
            id: true,
            title: true,
            abstract: true,
            keywords: true,
            authors: true,
            corresponding_author_email: true,
            manuscript_file_url: true,
            submission_date: true,
            publication_date: true,
            doi: true,
            crossrefDoi: true,
            status: true,
            volume: true,
            issue: true,
            page_start: true,
            page_end: true,
            subject_area: true,
            funding_info: true,
            conflicts_of_interest: true,
            vetting_fee: true,
            processing_fee: true,
            created_at: true,
            updated_at: true,
          },
        },
        submitter: { select: { id: true, full_name: true, email: true } },
      },
    });

    // Fire-and-forget — don't let email failure break the submission
    sendSubmissionReceivedEmail({
      to: submission.submitter.email,
      recipientId: submission.submitter_id,
      submissionId: submission.id,
      name: submission.submitter.full_name,
      title: article.title,
      submissionDate: new Date().toLocaleDateString("en-GB"),
    }).catch((err) => console.error("[email] submission_received:", err.message));

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

  // Write fee flags to the article (single source of truth — frontend reads from article)
  const articleFeeData = {};
  if (vetting_fee !== undefined) articleFeeData.vetting_fee = vetting_fee;
  if (processing_fee !== undefined) articleFeeData.processing_fee = processing_fee;
  if (Object.keys(articleFeeData).length > 0) {
    await prisma.article.update({
      where: { id: submission.article_id },
      data: articleFeeData,
    });
  }

  const updated = await prisma.submission.update({
    where: { id },
    data: updateData,
    include: {
      article: { select: { id: true, title: true, status: true, vetting_fee: true, processing_fee: true } },
      submitter: { select: { full_name: true, email: true } },
    },
  });

  if (approved_by_editor) {
    sendSubmissionAcceptedEmail({
      to: updated.submitter.email,
      recipientId: updated.submitter_id,
      submissionId: id,
      name: updated.submitter.full_name,
      title: updated.article.title,
    }).catch((err) => console.error("[email] submission_accepted:", err.message));
  }

  return updated;
};
