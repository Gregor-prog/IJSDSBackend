import prisma from "../../config/prisma.js";

export const listRevisionRequests = async (submissionId) => {
  return prisma.revisionRequest.findMany({
    where: { submission_id: submissionId },
    orderBy: { created_at: "desc" },
  });
};

export const createRevisionRequest = async (data, requestedBy) => {
  const { submission_id, revision_type, request_details, deadline_date } = data;

  if (!submission_id || !revision_type || !request_details) {
    const err = new Error("submission_id, revision_type and request_details are required");
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
    const request = await tx.revisionRequest.create({
      data: {
        submission_id,
        requested_by: requestedBy,
        revision_type,
        request_details,
        deadline_date: deadline_date ? new Date(deadline_date) : null,
      },
    });

    await tx.submission.update({
      where: { id: submission_id },
      data: { status: "revision_requested" },
    });

    await tx.workflowAuditLog.create({
      data: {
        submission_id,
        old_status: submission.status,
        new_status: "revision_requested",
        changed_by: requestedBy,
        change_reason: `${revision_type} revision requested`,
        metadata: { revision_request_id: request.id },
      },
    });

    return request;
  });
};
