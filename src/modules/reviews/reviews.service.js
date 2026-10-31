import prisma from "../../config/prisma.js";
import { sendReviewAssignedEmail, sendReviewSubmittedEmail } from "../email/email.service.js";
import { createNotification } from "../notifications/notifications.service.js";
import { releaseReviewerLoad, acquireReviewerLoad, assertReviewerInvitable } from "../ijsds2/matching.service.js";
import { transitionManuscript } from "../ijsds2/stateMachine.js";
import { StorageService } from "../../services/storage.service.js";

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const isStaff = (u) => u.is_admin || u.is_editor || u.role === "admin" || u.role === "editor";

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

export const getReview = async (id, user) => {
  const review = await prisma.review.findUnique({
    where: { id },
    include: {
      reviewer: { select: { id: true, full_name: true, email: true } },
      submission: {
        select: {
          id: true,
          article_id: true,
          submitter_id: true,
          status: true,
          submitted_at: true,
          article: { select: { id: true, title: true, abstract: true, manuscript_file_url: true, vetting_fee: true, processing_fee: true } },
        },
      },
    },
  });
  if (!review) throw httpErr(404, "Review not found");

  if (isStaff(user)) return review;

  if (review.reviewer_id === user.id) {
    // Double-blind: a reviewer never sees who the author is.
    const { submitter_id, ...submission } = review.submission ?? {};
    return { ...review, submission };
  }

  // The submitting author may read only a *submitted* review, minus reviewer identity
  // and editor-only comments.
  if (review.submission?.submitter_id === user.id && review.submitted_at) {
    return {
      id: review.id,
      submission_id: review.submission_id,
      recommendation: review.recommendation,
      comments_to_author: review.comments_to_author,
      submitted_at: review.submitted_at,
      review_round: review.review_round,
    };
  }
  throw httpErr(403, "Forbidden");
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

  // IJSDS 2.0: manual invites go through the same COPE firewall and stage gate as automated ones.
  await assertReviewerInvitable(prisma, submission_id, reviewer_id);

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

  // Editor-initiated invitations also count toward the reviewer's workload (cap = 3).
  acquireReviewerLoad(reviewer_id).catch((err) =>
    console.error("[ijsds2] could not record reviewer load:", err.message),
  );

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

const REVIEWER_FIELDS = [
  "invitation_status", "recommendation", "comments_to_author", "comments_to_editor",
  "conflict_of_interest_declared", "conflict_of_interest_details", "submit",
];

// Editors open this link, so reviewers set it only by uploading, never as a free-form URL.
const loadEditableReviewFile = async (id, user) => {
  const review = await prisma.review.findUnique({ where: { id }, select: { id: true, reviewer_id: true, submitted_at: true, review_file_url: true } });
  if (!review) throw httpErr(404, "Review not found");
  if (!isStaff(user)) {
    if (review.reviewer_id !== user.id) throw httpErr(403, "Forbidden");
    if (review.submitted_at) throw httpErr(409, "This review has already been submitted and can no longer be edited");
  }
  return review;
};

const deleteStoredReviewFile = async (url) => {
  const path = url && decodeURIComponent(new URL(url).pathname).split("/").slice(-3).join("/");
  if (path?.startsWith("reviews/")) {
    await StorageService.delete(path).catch((e) => console.error("[reviews] could not delete old file:", e.message));
  }
};

export const attachReviewFile = async (id, file, user) => {
  if (!file) throw httpErr(400, "No file uploaded");
  const review = await loadEditableReviewFile(id, user);
  const safeName = file.originalname.replace(/[^a-z0-9.]/gi, "_").replace(/_+/g, "_");
  const path = `reviews/${id}/${Date.now()}-${safeName}`;
  await StorageService.upload(path, file.buffer, file.mimetype);
  const updated = await prisma.review.update({ where: { id }, data: { review_file_url: StorageService.getPublicUrl(path) }, select: { id: true, review_file_url: true } });
  await deleteStoredReviewFile(review.review_file_url);
  return updated;
};

export const removeReviewFile = async (id, user) => {
  const review = await loadEditableReviewFile(id, user);
  const updated = await prisma.review.update({ where: { id }, data: { review_file_url: null }, select: { id: true, review_file_url: true } });
  await deleteStoredReviewFile(review.review_file_url);
  return updated;
};

export const updateReview = async (id, data, user) => {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) throw httpErr(404, "Review not found");

  const staff = isStaff(user);
  const owner = review.reviewer_id === user.id;
  // Only the assigned reviewer or editorial staff may touch a review. (Previously any
  // authenticated non-"reviewer" account could PATCH any review by id.)
  if (!staff && !owner) throw httpErr(403, "Forbidden");

  if (!staff) {
    const illegal = Object.keys(data ?? {}).filter((k) => !REVIEWER_FIELDS.includes(k) && k !== "role");
    if (illegal.length) throw httpErr(403, `Reviewers cannot change: ${illegal.join(", ")}`);
    if (review.submitted_at) throw httpErr(409, "This review has already been submitted and can no longer be edited");
    if (review.invitation_status === "declined") throw httpErr(409, "You declined this invitation");
  }

  const updateData = {};
  let acceptedNow = false;

  if (data.invitation_status) {
    if (!["accepted", "declined"].includes(data.invitation_status) && !staff) throw httpErr(400, "invitation_status must be accepted or declined");
    updateData.invitation_status = data.invitation_status;
    if (data.invitation_status === "accepted" && review.invitation_status !== "accepted") {
      updateData.invitation_accepted_at = new Date();
      acceptedNow = true;
    }
  }

  if (data.recommendation) updateData.recommendation = data.recommendation;
  if (data.comments_to_author !== undefined) updateData.comments_to_author = data.comments_to_author;
  if (data.comments_to_editor !== undefined) updateData.comments_to_editor = data.comments_to_editor;
  if (data.review_file_url !== undefined) updateData.review_file_url = data.review_file_url;
  if (data.conflict_of_interest_declared !== undefined) {
    updateData.conflict_of_interest_declared = data.conflict_of_interest_declared;
    updateData.conflict_of_interest_details = data.conflict_of_interest_details ?? null;
  }

  const isNewSubmission = data.submit === true && !review.submitted_at;
  if (isNewSubmission) {
    updateData.submitted_at = new Date();
    // The UI has no separate accept step: submitting implies accepting.
    if (review.invitation_status === "pending") {
      updateData.invitation_status = "accepted";
      updateData.invitation_accepted_at = new Date();
      acceptedNow = true;
    }
  }

  if (staff && data.deadline_date) updateData.deadline_date = new Date(data.deadline_date);

  const declinedNow = updateData.invitation_status === "declined" && review.invitation_status !== "declined" && !review.submitted_at;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.review.update({ where: { id }, data: updateData });
    if (acceptedNow) {
      // First reviewer to accept moves the manuscript into peer review (PRD Stage 4).
      const m = await tx.manuscript.findUnique({ where: { submission_id: review.submission_id }, select: { id: true, current_state: true } });
      if (m?.current_state === "REVIEWER_MATCHED") {
        await transitionManuscript(tx, m.id, "REVIEWER_MATCHED", "IN_PEER_REVIEW", {}, { changedBy: user.id, reason: "Reviewer accepted invitation" });
      }
    }
    return row;
  });

  // Free the workload slot exactly once: on decline, or on submit (never both).
  if ((declinedNow || isNewSubmission) && review.reviewer_id) {
    releaseReviewerLoad(review.reviewer_id).catch((err) =>
      console.error("[ijsds2] could not release reviewer load:", err.message),
    );
  }

  if (declinedNow) {
    alertIfAllDeclined(review.submission_id).catch((err) => console.error("[review] decline alert failed:", err.message));
  }

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

/** If every invited reviewer for the current round has declined, tell the editors. */
const alertIfAllDeclined = async (submissionId) => {
  const reviews = await prisma.review.findMany({ where: { submission_id: submissionId }, select: { invitation_status: true, review_round: true } });
  const round = Math.max(1, ...reviews.map((r) => r.review_round));
  const current = reviews.filter((r) => r.review_round === round);
  if (!current.length || !current.every((r) => r.invitation_status === "declined")) return;
  const sub = await prisma.submission.findUnique({ where: { id: submissionId }, select: { article: { select: { title: true } } } });
  const editors = await prisma.profile.findMany({ where: { OR: [{ role: "editor" }, { is_editor: true }] }, select: { id: true } });
  await Promise.all(editors.map((e) => createNotification({ user_id: e.id, title: "All reviewers declined", message: `Every reviewer declined "${sub?.article?.title ?? "a manuscript"}". Assign new reviewers.`, type: "warning" })));
};
