import prisma from "../../config/prisma.js";
import { sendDecisionEmail } from "../email/email.service.js";

export const listDecisions = async (submissionId) => {
  return prisma.editorialDecision.findMany({
    where: { submission_id: submissionId },
    orderBy: { created_at: "desc" },
  });
};

export const createDecision = async (data, editorId) => {
  const { submission_id, decision_type, decision_rationale } = data;

  if (!submission_id || !decision_type) {
    const err = new Error("submission_id and decision_type are required");
    err.status = 400;
    throw err;
  }

  // Map decision type to new submission status
  const statusMap = {
    desk_reject: "rejected",
    send_for_review: "under_review",
    accept: "accepted",
    reject: "rejected",
    minor_revision: "revision_requested",
    major_revision: "revision_requested",
  };

  const newStatus = statusMap[decision_type];

  return prisma.$transaction(async (tx) => {
    const decision = await tx.editorialDecision.create({
      data: {
        submission_id,
        editor_id: editorId,
        decision_type,
        decision_rationale,
      },
    });

    const currentSubmission = await tx.submission.findUnique({
      where: { id: submission_id },
      include: {
        article: { select: { title: true } },
        submitter: { select: { id: true, full_name: true, email: true } },
      },
    });

    await tx.submission.update({
      where: { id: submission_id },
      data: { status: newStatus },
    });

    await tx.workflowAuditLog.create({
      data: {
        submission_id,
        old_status: currentSubmission.status,
        new_status: newStatus,
        changed_by: editorId,
        change_reason: `Editorial decision: ${decision_type}`,
        metadata: { decision_id: decision.id },
      },
    });

    const decisionLabels = {
      desk_reject: "Desk Rejected",
      send_for_review: "Sent for Peer Review",
      accept: "Accepted",
      reject: "Rejected",
      minor_revision: "Minor Revision Required",
      major_revision: "Major Revision Required",
    };

    sendDecisionEmail({
      to: currentSubmission.submitter.email,
      recipientId: currentSubmission.submitter.id,
      submissionId: submission_id,
      name: currentSubmission.submitter.full_name,
      title: currentSubmission.article.title,
      decision: decisionLabels[decision_type] ?? decision_type,
      decisionRationale: decision_rationale ?? null,
    }).catch((err) => console.error("[email] decision_made:", err.message));

    return decision;
  });
};
