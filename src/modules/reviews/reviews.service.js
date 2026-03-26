import prisma from "../../config/prisma.js";

export const listReviews = async ({ submissionId, reviewerId, role, userId }) => {
  const where = {};
  if (submissionId) where.submission_id = submissionId;
  if (reviewerId) where.reviewer_id = reviewerId;

  // Reviewers only see their own reviews
  if (role === "reviewer") where.reviewer_id = userId;

  return prisma.review.findMany({
    where,
    include: {
      reviewer: {
        select: { id: true, full_name: true, email: true, affiliation: true },
      },
      submission: {
        select: { id: true, status: true, article: { select: { title: true } } },
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

  return prisma.review.create({
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
    },
  });
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

  // Mark as submitted if recommendation is provided
  if (data.recommendation && !review.submitted_at) {
    updateData.submitted_at = new Date();
  }

  // Editors can update deadline
  if (role !== "reviewer" && data.deadline_date) {
    updateData.deadline_date = new Date(data.deadline_date);
  }

  return prisma.review.update({ where: { id }, data: updateData });
};
