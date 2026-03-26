import prisma from "../../config/prisma.js";

export const listRejectionMessages = async (submissionId) => {
  return prisma.rejectionMessage.findMany({
    where: { submission_id: submissionId },
    orderBy: { created_at: "desc" },
  });
};

export const createRejectionMessage = async (data, createdBy) => {
  const { submission_id, message, suggested_corrections } = data;

  if (!submission_id || !message) {
    const err = new Error("submission_id and message are required");
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

  return prisma.$transaction(async (tx) => {
    const rejection = await tx.rejectionMessage.create({
      data: {
        submission_id,
        message,
        suggested_corrections,
        created_by: createdBy,
      },
    });

    await tx.submission.update({
      where: { id: submission_id },
      data: { status: "rejected" },
    });

    await tx.workflowAuditLog.create({
      data: {
        submission_id,
        old_status: submission.status,
        new_status: "rejected",
        changed_by: createdBy,
        change_reason: "Submission rejected",
        metadata: { rejection_message_id: rejection.id },
      },
    });

    return rejection;
  });
};
