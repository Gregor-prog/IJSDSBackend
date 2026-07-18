import prisma from "../../config/prisma.js";
import { sendReviewAssignedEmail, sendReviewSubmittedEmail } from "../email/email.service.js";
import { createNotification } from "../notifications/notifications.service.js";

export const listReviews = async ({ submissionId, reviewerId, role, userId, is_reviewer, is_editor, is_admin }) => {
  const hasElevatedAccess = is_editor || is_admin || role === "editor" || role === "admin";
  const isReviewer = !hasElevatedAccess && (is_reviewer || role === "reviewer");

  // ── Author-facing view ──────────────────────────────────────────────────────
  // A plain author may only see *submitted* reviews on their *own* submissions.
  // Reviewer identity and editor-only comments are withheld (double-blind), so
  // this uses an explicit select rather than include.
  if (!hasElevatedAccess && !isReviewer) {
    const where = {
      submitted_at: { not: null },
      submission: { submitter_id: userId },
    };
    if (submissionId) where.submission_id = submissionId;

    return prisma.review.findMany({
      where,
      select: {
        id: true,
        submission_id: true,
        recommendation: true,
        comments_to_author: true,
        submitted_at: true,
        review_round: true,
        submission: {
          select: {
            id: true,
            article_id: true,
            article: { select: { id: true, title: true } },
          },
        },
      },
      orderBy: { submitted_at: "desc" },
    });
  }

  // ── Reviewer / editor / admin view ──────────────────────────────────────────
  const where = {};
  if (submissionId) where.submission_id = submissionId;
  if (reviewerId) where.reviewer_id = reviewerId;

  if (isReviewer) {
    where.reviewer_id = userId;
    // Once an article is published, drop it from the reviewer's dashboard
    where.submission = { article: { status: { not: "published" } } };
  }

  return prisma.review.findMany({
    where,
    include: {
      reviewer: {
        select: { id: true, full_name: true, email: true, affiliation: true },
      },
      submission: {
        select: {
          id: true,
          article_id: true,
          status: true,
          submitted_at: true,
          article: {
            select: {
              id: true,
              title: true,
              abstract: true,
              subject_area: true,
              status: true,
              manuscript_file_url: true,
              corresponding_author_email: true,
              vetting_fee: true,
              processing_fee: true,
            },
          },
        },
      },
    },
    orderBy: { created_at: "desc" },
  });
};

export const getReview = async (id, { userId, role }) => {
  const review = await prisma.review.findUnique({
    where: { id },
    include: {
      reviewer: { select: { id: true, full_name: true, email: true } },
      submission: {
        include: { article: { select: { id: true, title: true, abstract: true } } },
      },
    },
  });

  if (!review) {
    const err = new Error("Review not found");
    err.status = 404;
    throw err;
  }

  if (role === "reviewer" && review.reviewer_id !== userId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  return review;
};

export const inviteReviewer = async (data) => {
  const { submission_id, reviewer_id, deadline_date, review_round } = data;

  // Ensure submission exists
  const submission = await prisma.submission.findUnique({
    where: { id: submission_id },
  });
  if (!submission) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  // Prevent duplicate invite in same round
  const existing = await prisma.review.findFirst({
    where: { submission_id, reviewer_id, review_round: review_round ?? 1 },
  });
  if (existing) {
    const err = new Error("Reviewer already invited for this round");
    err.status = 409;
    throw err;
  }

  const review = await prisma.review.create({
    data: {
      submission_id,
      reviewer_id,
      review_round: review_round ?? 1,
      deadline_date: deadline_date ? new Date(deadline_date) : null,
      invitation_status: "pending",
      invitation_sent_at: new Date(),
    },
    include: {
      reviewer: { select: { id: true, full_name: true, email: true } },
      submission: { include: { article: { select: { title: true } } } },
    },
  });

  sendReviewAssignedEmail({
    to: review.reviewer.email,
    recipientId: review.reviewer.id,
    submissionId: submission_id,
    reviewerName: review.reviewer.full_name,
    title: review.submission.article.title,
    deadline: deadline_date ?? "To be confirmed",
  }).catch((err) => console.error("[email] review_assigned:", err.message));

  return review;
};

export const updateReview = async (id, data, { userId, role }) => {
  const review = await prisma.review.findUnique({ where: { id } });

  if (!review) {
    const err = new Error("Review not found");
    err.status = 404;
    throw err;
  }

  // Reviewers can only update their own
  if (role === "reviewer" && review.reviewer_id !== userId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const updateData = {};

  // Reviewer accepting / declining invitation
  if (data.invitation_status) {
    updateData.invitation_status = data.invitation_status;
    if (data.invitation_status === "accepted") {
      updateData.invitation_accepted_at = new Date();
    }
  }

  // Reviewer submitting their review
  if (data.recommendation) updateData.recommendation = data.recommendation;
  if (data.comments_to_author !== undefined) updateData.comments_to_author = data.comments_to_author;
  if (data.comments_to_editor !== undefined) updateData.comments_to_editor = data.comments_to_editor;
  if (data.review_file_url !== undefined) updateData.review_file_url = data.review_file_url;
  if (data.conflict_of_interest_declared !== undefined) {
    updateData.conflict_of_interest_declared = data.conflict_of_interest_declared;
    updateData.conflict_of_interest_details = data.conflict_of_interest_details ?? null;
  }

  // Mark as submitted only if explicitly requested
  const isNewSubmission = data.submit === true && !review.submitted_at;
  if (isNewSubmission) {
    updateData.submitted_at = new Date();
  }

  // Editors can update deadline
  if (role !== "reviewer" && data.deadline_date) {
    updateData.deadline_date = new Date(data.deadline_date);
  }

  const updated = await prisma.review.update({ where: { id }, data: updateData });

  // Notify the submitting author when a review is newly completed.
  // Fire-and-forget: a notification failure must never fail the review save.
  if (isNewSubmission) {
    notifyAuthorOfReview(updated).catch((err) =>
      console.error("[review] author notification failed:", err.message),
    );
  }

  return updated;
};

/**
 * Notifies the submitting author (email + in-app) that a review has come in.
 * Double-blind: the reviewer's identity is never included.
 */
const notifyAuthorOfReview = async (review) => {
  if (!review?.submission_id) return;

  const submission = await prisma.submission.findUnique({
    where: { id: review.submission_id },
    select: {
      id: true,
      submitter: { select: { id: true, full_name: true, email: true } },
      article: { select: { title: true } },
    },
  });

  const submitter = submission?.submitter;
  if (!submitter?.id) return;

  const title = submission.article?.title ?? "your manuscript";

  await createNotification({
    user_id: submitter.id,
    title: "New review received",
    message: `A reviewer has submitted feedback on "${title}".`,
    type: "info",
  });

  if (submitter.email) {
    await sendReviewSubmittedEmail({
      to: submitter.email,
      recipientId: submitter.id,
      submissionId: submission.id,
      name: submitter.full_name ?? "Author",
      title,
    });
  }
};
