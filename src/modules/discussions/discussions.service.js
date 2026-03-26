import prisma from "../../config/prisma.js";

// ── Threads ───────────────────────────────────────────────────────────────────

export const listThreads = async (submissionId) => {
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

export const createThread = async (data, userId) => {
  const { submission_id, title } = data;

  if (!submission_id || !title) {
    const err = new Error("submission_id and title are required");
    err.status = 400;
    throw err;
  }

  const submission = await prisma.submission.findUnique({
    where: { id: submission_id },
  });
  if (!submission) {
    const err = new Error("Submission not found");
    err.status = 404;
    throw err;
  }

  return prisma.discussionThread.create({
    data: { submission_id, title, created_by: userId },
  });
};

// ── Messages ──────────────────────────────────────────────────────────────────

export const listMessages = async (threadId, { userId, role }) => {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
    include: { submission: { select: { submitter_id: true } } },
  });

  if (!thread) {
    const err = new Error("Thread not found");
    err.status = 404;
    throw err;
  }

  // Authors can only read threads on their own submissions
  if (role === "author" && thread.submission.submitter_id !== userId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  return prisma.discussionMessage.findMany({
    where: { thread_id: threadId },
    orderBy: { created_at: "asc" },
  });
};

export const createMessage = async (threadId, content, userId) => {
  if (!content?.trim()) {
    const err = new Error("content is required");
    err.status = 400;
    throw err;
  }

  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
  });
  if (!thread) {
    const err = new Error("Thread not found");
    err.status = 404;
    throw err;
  }

  const [message] = await prisma.$transaction([
    prisma.discussionMessage.create({
      data: { thread_id: threadId, author_id: userId, content },
    }),
    // Bump thread updated_at so it sorts to top
    prisma.discussionThread.update({
      where: { id: threadId },
      data: { updated_at: new Date() },
    }),
  ]);

  return message;
};
