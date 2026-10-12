import { TRANSITIONS, httpError } from "./ijsds2.constants.js";

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/**
 * Compare-and-set state change inside a transaction. The WHERE clause on the current
 * state makes concurrent webhook/verify/worker calls safe: only one of them wins, the
 * rest get a 409 instead of double-applying side effects.
 */
export const transitionManuscript = async (tx, manuscriptId, from, to, extra = {}, audit = {}) => {
  if (!canTransition(from, to)) {
    throw httpError(409, `Illegal manuscript transition ${from} -> ${to}`);
  }

  const { count } = await tx.manuscript.updateMany({
    where: { id: manuscriptId, current_state: from },
    data: { current_state: to, ...extra },
  });
  if (count !== 1) {
    throw httpError(409, `Manuscript is no longer in state ${from}`);
  }

  const m = await tx.manuscript.findUnique({
    where: { id: manuscriptId },
    select: { submission_id: true },
  });
  await tx.workflowAuditLog.create({
    data: {
      submission_id: m.submission_id,
      old_status: from,
      new_status: to,
      changed_by: audit.changedBy ?? null,
      change_reason: audit.reason ?? null,
      metadata: { source: "ijsds2", ...(audit.metadata ?? {}) },
    },
  });
};
