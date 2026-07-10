import prisma from "../../config/prisma.js";

// ── Access control ────────────────────────────────────────────────────────────

/**
 * Ensures the user may read/write discussions for a submission.
 * Participants are: editors/admins, the submitting author, and any reviewer
 * assigned to the submission. Everyone else is Forbidden.
 *
 * @param {string} submissionId
 * @param {{ id: string, role?: string, is_editor?: boolean, is_admin?: boolean }} user - req.user
 */
const assertSubmissionParticipant = async (submissionId, user) => {
  const { id: userId, role, is_editor, is_admin } = user ?? {};

  // Editors and admins always have access
  if (is_editor || is_admin || role === "editor" || role === "admin") return;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { id: true, submitter_id: true },
  });
  if (!submission) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  // The submitting author
  if (submission.submitter_id === userId) return;

  // A reviewer assigned to this submission
  const review = await prisma.review.findFirst({
    where: { submission_id: submissionId, reviewer_id: userId },
    select: { id: true },
  });
  if (review) return;

  const err = new Error("Forbidden");
  err.status = 403;
  throw err;
};

// ── Threads ───────────────────────────────────────────────────────────────────

export const listThreads = async (submissionId, user) => {
  await assertSubmissionParticipant(submissionId, user);

  return prisma.discussionThread.findMany({
    where: { submission_id: submissionId },
    include: {
      messages: {
        orderBy: { created_at: "asc" },
        take: 1, // preview: just the first message
      },
      _count: { select: { messages: true } },
    },
    orderBy: { updated_at: "desc" },
  });
};

export const createThread = async (data, user) => {
  const { submission_id, title } = data;

  if (!submission_id || !title) {
    const err = new Error("submission_id and title are required");
    err.status = 400;
    throw err;
  }

  await assertSubmissionParticipant(submission_id, user);

  return prisma.discussionThread.create({
    data: { submission_id, title, created_by: user.id },
  });
};

// ── Messages ──────────────────────────────────────────────────────────────────

export const listMessages = async (threadId, user) => {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
    select: { id: true, submission_id: true },
  });

  if (!thread) {
    const err = new Error("Thread not found");
    err.status = 404;
    throw err;
  }

  await assertSubmissionParticipant(thread.submission_id, user);

  return prisma.discussionMessage.findMany({
    where: { thread_id: threadId },
    orderBy: { created_at: "asc" },
  });
};

export const createMessage = async (threadId, content, user) => {
  if (!content?.trim()) {
    const err = new Error("content is required");
    err.status = 400;
    throw err;
  }

  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
    select: { id: true, submission_id: true },
  });
  if (!thread) {
    const err = new Error("Thread not found");
    err.status = 404;
    throw err;
  }

  await assertSubmissionParticipant(thread.submission_id, user);

  const [message] = await prisma.$transaction([
    prisma.discussionMessage.create({
      data: { thread_id: threadId, author_id: user.id, content },
    }),
    // Bump thread updated_at so it sorts to top
    prisma.discussionThread.update({
      where: { id: threadId },
      data: { updated_at: new Date() },
    }),
  ]);

  return message;
};
