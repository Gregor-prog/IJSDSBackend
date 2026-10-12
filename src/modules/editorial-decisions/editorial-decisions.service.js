import prisma from "../../config/prisma.js";
import { sendDecisionEmail } from "../email/email.service.js";
import { transitionManuscript } from "../ijsds2/stateMachine.js";
import { syncManuscriptWithArticleStatus } from "../ijsds2/manuscripts.service.js";

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
        article: { select: { id: true, title: true, doi: true } },
        submitter: { select: { id: true, full_name: true, email: true } },
      },
    });

    await tx.submission.update({
      where: { id: submission_id },
      data: { status: newStatus },
    });

    // IJSDS 2.0: peer-review entry and acceptance require a cleared audit and paid Gate 2.
    // Throws 409 (rolling back this decision) if the manuscript hasn't earned that stage.
    if (decision_type === "send_for_review" || decision_type === "accept") {
      await syncManuscriptWithArticleStatus(tx, currentSubmission.article_id, newStatus, editorId);
    }

    // Peer-review revision decisions put the manuscript in the author's court (PRD Stage 4).
    if (decision_type === "minor_revision" || decision_type === "major_revision") {
      const m = await tx.manuscript.findUnique({ where: { submission_id }, select: { id: true, current_state: true } });
      if (m?.current_state === "IN_PEER_REVIEW") {
        await transitionManuscript(tx, m.id, "IN_PEER_REVIEW", "AUTHOR_REVISION_REQUESTED", {}, { changedBy: editorId, reason: `Editorial decision: ${decision_type}` });
      }
    }

    // When accepted, mark the article as accepted too
    if (decision_type === "accept") {
      await tx.article.update({
        where: { id: currentSubmission.article_id },
        data: { status: "accepted" },
      });
    }

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
