import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { FINANCIALS, GATES, computeGate2Split } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { scheduleAuditTx } from "./audit.service.js";
import { enqueueAudit } from "./ijsds2.queue.js";
import { createNotification } from "../notifications/notifications.service.js";

/**
 * The fee flags on the article (vetting_fee = Gate 1 evaluation fee, processing_fee = Gate 2
 * publication fee) are the system of record for "has this been paid". The manuscript's
 * workflow state must always agree with them, whoever set the flag (a verified Paystack
 * payment, an editor, a backfill, a manual database fix).
 *
 * reconcileFromFlags() moves the manuscript forward when a flag says paid but the state is
 * still waiting for that fee. It runs the same transitions, ledgers and audit scheduling as a
 * Paystack settlement, attributed to "system" with the reason recorded. It is idempotent and
 * safe to call from anywhere, any number of times.
 */

const settleFromFlag = async (manuscriptId, gate, article) => {
  const spec = GATES[gate];
  const expectedFrom = gate === "GATE_1" ? "DRAFT_PENDING_FEE1" : "AUDIT_PASSED_PENDING_APC";
  const originalRef = gate === "GATE_1" ? article.vetting_reference : article.processing_reference;
  const why = `Fee flag already recorded as paid${originalRef ? ` (reference ${originalRef})` : ""}`;

  const result = await prisma.$transaction(async (db) => {
    const m = await db.manuscript.findUnique({ where: { id: manuscriptId } });
    if (!m || m.current_state !== expectedFrom) return null; // someone else already moved it

    // Prefer the real Paystack reference if the old flow stored one and it isn't in the ledger yet.
    const taken = originalRef ? await db.paymentLedger.findUnique({ where: { gateway_reference: originalRef } }) : true;
    const reference = taken ? `FLAG-${crypto.randomUUID()}` : originalRef;

    const ledger = await db.paymentLedger.create({
      data: {
        manuscript_id: manuscriptId,
        gateway_reference: reference,
        payment_type: spec.payment_type,
        amount_naira: spec.amount_naira,
        status: "success",
        raw_webhook_payload: { source: "fee-flag", original_reference: originalRef ?? null, note: "Reconciled from the article's paid flag; not re-verified with Paystack" },
      },
    });
    const audit = { changedBy: null, reason: `Reconciled from fee flag: ${why}`, metadata: { source: "fee-flag", reference } };

    if (gate === "GATE_1") {
      await transitionManuscript(db, manuscriptId, "DRAFT_PENDING_FEE1", "SUBMITTED", {}, audit);
      const scheduled = await scheduleAuditTx(db, { ...m, current_state: "SUBMITTED" }, { reason: "Stage 2 audit queued (24h window)" });
      return { gate, ...scheduled };
    }

    await db.gate2DistributionLedger.create({ data: { manuscript_id: manuscriptId, payment_ledger_id: ledger.id, ...computeGate2Split(spec.amount_naira) } });
    let referralCredited = false;
    if (m.referred_by_reviewer_id) {
      await db.referralPayoutLedger.create({
        data: { reviewer_id: m.referred_by_reviewer_id, manuscript_id: manuscriptId, amount_naira: FINANCIALS.REFERRAL_COMMISSION_NAIRA, status: "CREDITED" },
      });
      await db.reviewerProfile.update({ where: { id: m.referred_by_reviewer_id }, data: { wallet_balance_naira: { increment: FINANCIALS.REFERRAL_COMMISSION_NAIRA } } });
      referralCredited = true;
    }
    await transitionManuscript(db, manuscriptId, "AUDIT_PASSED_PENDING_APC", "APC_PAID", {}, audit);
    return { gate, referralCredited };
  });

  if (result?.revisionNo) {
    enqueueAudit(manuscriptId, result.revisionNo, result.scheduledFor).catch((e) =>
      console.error("[ijsds2] audit enqueue failed (sweeper will recover):", e.message),
    );
  }
  if (result) {
    const m = await prisma.manuscript.findUnique({ where: { id: manuscriptId }, select: { author_id: true, title: true } });
    createNotification({
      user_id: m.author_id,
      title: gate === "GATE_1" ? "Evaluation (vetting) fee confirmed" : "Publication fee confirmed",
      message:
        gate === "GATE_1"
          ? `The evaluation fee for "${m.title}" is recorded as paid. Your integrity audit has been scheduled.`
          : `The publication fee for "${m.title}" is recorded as paid. Your manuscript now moves to reviewer assignment.`,
      type: "success",
    }).catch(() => {});
  }
  return result;
};

/** Brings one manuscript's workflow state in line with its fee flags. Returns the gates it settled. */
export const reconcileFromFlags = async (manuscriptId) => {
  const settled = [];
  // Gate 1 can unlock Gate 2 in one pass (flag already true for both), so loop at most twice.
  for (let i = 0; i < 2; i++) {
    const m = await prisma.manuscript.findUnique({
      where: { id: manuscriptId },
      select: { current_state: true, submission: { select: { article: { select: { vetting_fee: true, processing_fee: true, vetting_reference: true, processing_reference: true } } } } },
    });
    const article = m?.submission?.article;
    if (!article) break;

    let gate = null;
    if (m.current_state === "DRAFT_PENDING_FEE1" && article.vetting_fee) gate = "GATE_1";
    else if (m.current_state === "AUDIT_PASSED_PENDING_APC" && article.processing_fee) gate = "GATE_2";
    if (!gate) break;

    try {
      const r = await settleFromFlag(manuscriptId, gate, article);
      if (!r) break;
      settled.push(gate);
    } catch (e) {
      if (e.status === 409 || e.code === "P2002") break; // raced with another reconcile/settlement: fine
      throw e;
    }
  }
  return settled;
};

/** Sweeps every manuscript whose flag and state disagree (used by the 10-minute sweeper). */
export const reconcileAllFromFlags = async () => {
  const rows = await prisma.manuscript.findMany({
    where: {
      OR: [
        { current_state: "DRAFT_PENDING_FEE1", submission: { article: { vetting_fee: true } } },
        { current_state: "AUDIT_PASSED_PENDING_APC", submission: { article: { processing_fee: true } } },
      ],
    },
    select: { id: true },
    take: 100,
  });
  let n = 0;
  for (const r of rows) n += (await reconcileFromFlags(r.id).catch((e) => (console.error("[ijsds2] reconcile failed:", r.id, e.message), []))).length;
  return n;
};
