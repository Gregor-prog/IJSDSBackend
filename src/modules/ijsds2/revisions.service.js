import prisma from "../../config/prisma.js";
import { httpError } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { createNotification } from "../notifications/notifications.service.js";
import { sendReviewAssignedEmail } from "../email/email.service.js";

const REREVIEW_DAYS = 14; // PRD Stage 4: 7-14 day iterative loop

/**
 * Author uploads a corrected manuscript after peer review asked for changes. The manuscript
 * goes back to IN_PEER_REVIEW and every reviewer who already submitted for the latest round
 * gets a fresh invitation for the next round (workload re-counted, cap not re-checked: they
 * are already on this paper).
 */
export const submitAuthorRevision = async (manuscriptId, user, fileUrl, note) => {
  const m = await prisma.manuscript.findUnique({ where: { id: manuscriptId } });
  if (!m) throw httpError(404, "Manuscript not found");
  if (m.author_id !== user.id) throw httpError(403, "Only the author can upload a revision");
  if (m.current_state !== "AUTHOR_REVISION_REQUESTED") throw httpError(409, `Not awaiting an author revision (state is ${m.current_state})`);
  if (!fileUrl) throw httpError(400, "A revised manuscript file (.pdf/.docx) is required");

  const result = await prisma.$transaction(async (tx) => {
    await transitionManuscript(tx, m.id, "AUTHOR_REVISION_REQUESTED", "IN_PEER_REVIEW", { raw_file_r2_key: fileUrl }, { changedBy: user.id, reason: note?.slice(0, 500) ?? "Author revision uploaded" });
    await tx.article.updateMany({ where: { submissions: { some: { id: m.submission_id } } }, data: { manuscript_file_url: fileUrl } });
    await tx.submission.update({ where: { id: m.submission_id }, data: { status: "under_review" } });

    const reviews = await tx.review.findMany({ where: { submission_id: m.submission_id }, include: { reviewer: { select: { id: true, full_name: true, email: true } } } });
    const round = Math.max(1, ...reviews.map((r) => r.review_round));
    const nextRound = round + 1;
    const deadline = new Date(Date.now() + REREVIEW_DAYS * 86400000);
    const invited = [];
    for (const r of reviews.filter((x) => x.review_round === round && x.submitted_at && x.reviewer_id)) {
      const dup = await tx.review.findFirst({ where: { submission_id: m.submission_id, reviewer_id: r.reviewer_id, review_round: nextRound } });
      if (dup) continue;
      await tx.review.create({ data: { submission_id: m.submission_id, reviewer_id: r.reviewer_id, review_round: nextRound, invitation_status: "accepted", invitation_accepted_at: new Date(), invitation_sent_at: new Date(), deadline_date: deadline } });
      await tx.$executeRaw`UPDATE reviewer_profiles SET active_load = active_load + 1 WHERE user_id = ${r.reviewer_id}::uuid`;
      invited.push(r.reviewer);
    }
    return { nextRound, invited };
  });

  for (const rv of result.invited) {
    createNotification({ user_id: rv.id, title: "Revised manuscript to re-review", message: `"${m.title}" was revised (round ${result.nextRound}). Please review by ${new Date(Date.now() + REREVIEW_DAYS * 86400000).toLocaleDateString("en-GB")}.`, type: "info" }).catch(() => {});
    if (rv.email) sendReviewAssignedEmail({ to: rv.email, recipientId: rv.id, submissionId: m.submission_id, reviewerName: rv.full_name, title: m.title, deadline: `${REREVIEW_DAYS} days` }).catch(() => {});
  }
  const editors = await prisma.profile.findMany({ where: { OR: [{ role: "editor" }, { is_editor: true }] }, select: { id: true } });
  await Promise.all(editors.map((e) => createNotification({ user_id: e.id, title: "Author revision received", message: `"${m.title}" was revised and sent back to reviewers (round ${result.nextRound}).`, type: "info" }).catch(() => {})));
  return { round: result.nextRound, reReviewers: result.invited.length };
};
