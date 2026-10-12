import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { FINANCIALS, GATES, acceptableKobo, computeGate2Split, httpError } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { scheduleAuditTx } from "./audit.service.js";
import { enqueueAudit } from "./ijsds2.queue.js";
import { createNotification } from "../notifications/notifications.service.js";

const PAYSTACK_BASE = "https://api.paystack.co";

const secretKey = () => {
  const key = process.env.PAYSTACK_SECRET_KEY_LIVE || process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw httpError(500, "Paystack secret key is not configured");
  return key;
};

const field = (tx, name) => tx.metadata?.custom_fields?.find((f) => f.variable_name === name)?.value;

const paystackVerify = async (reference) => {
  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.status) throw httpError(502, "Could not verify payment with Paystack");
  return json.data;
};

/**
 * Settles a Gate 1 / Gate 2 payment. This is the ONLY place money moves the state machine.
 * The amount, currency, payer and gate are all taken from Paystack's own verified record —
 * never from the browser — and the whole settlement is one DB transaction keyed by the
 * unique gateway_reference, so retries / webhook+verify races are idempotent.
 */
export const settlePayment = async ({ reference, gate, manuscriptId, payerUserId = null, payerEmail = null }) => {
  const spec = GATES[gate];
  if (!spec) throw httpError(400, "gate must be GATE_1 or GATE_2");
  if (!reference) throw httpError(400, "reference is required");

  const tx = await paystackVerify(reference);
  if (tx.status !== "success") throw httpError(402, "Payment has not succeeded");
  if (tx.currency !== "NGN") throw httpError(400, "Only NGN payments are supported by the IJSDS 2.0 fee schedule");
  const track = field(tx, "billing_track") === "global" ? "global" : "local";
  const { min, max } = acceptableKobo(gate, track);
  if (tx.amount < min || tx.amount > max) {
    throw httpError(
      400,
      `Amount mismatch for ${gate} (${track} track): expected ₦${(min / 100).toLocaleString()}${max > min ? `–₦${(max / 100).toLocaleString()}` : ""}, received ₦${(tx.amount / 100).toLocaleString()}`,
    );
  }
  // Ledger records the PRD net fee for local payments (the gross-up is processor cost);
  // the exact charged amount is kept in raw_webhook_payload.
  const ledgerNaira = track === "global" ? tx.amount / 100 : spec.amount_naira;
  const taggedGate = field(tx, "gate");
  if (taggedGate && taggedGate !== gate) throw httpError(400, "Payment was made for a different gate");
  const taggedManuscript = field(tx, "manuscript_id");
  if (taggedManuscript && taggedManuscript !== manuscriptId) throw httpError(400, "Payment belongs to a different manuscript");

  const manuscript = await prisma.manuscript.findUnique({ where: { id: manuscriptId } });
  if (!manuscript) throw httpError(404, "Manuscript not found");

  // Payer binding: the Paystack record must belong to the manuscript's author.
  const submitterTag = field(tx, "submitter_id");
  const author = await prisma.profile.findUnique({ where: { id: manuscript.author_id }, select: { email: true } });
  const emailMatches = author?.email && tx.customer?.email?.toLowerCase() === author.email.toLowerCase();
  if (submitterTag ? submitterTag !== manuscript.author_id : !emailMatches) {
    throw httpError(403, "This payment was not made by the manuscript's author");
  }
  if (payerUserId && payerUserId !== manuscript.author_id) throw httpError(403, "Only the manuscript's author can submit this payment");

  const expectedFrom = gate === "GATE_1" ? "DRAFT_PENDING_FEE1" : "AUDIT_PASSED_PENDING_APC";

  try {
    const result = await prisma.$transaction(async (db) => {
      const existing = await db.paymentLedger.findUnique({ where: { gateway_reference: reference } });
      if (existing) {
        if (existing.manuscript_id !== manuscriptId) throw httpError(409, "Reference already used for another manuscript");
        return { alreadyProcessed: true };
      }

      const fresh = await db.manuscript.findUnique({ where: { id: manuscriptId } });
      if (fresh.current_state !== expectedFrom) {
        // Real money arrived that we cannot apply (e.g. double payment). Keep the evidence
        // for refund/reconciliation; apply no side effects.
        await db.paymentLedger.create({
          data: {
            manuscript_id: manuscriptId,
            gateway_reference: reference,
            payment_type: spec.payment_type,
            amount_naira: ledgerNaira,
            status: "needs_review",
            raw_webhook_payload: tx,
          },
        });
        return { needsReview: true, state: fresh.current_state };
      }

      const ledger = await db.paymentLedger.create({
        data: {
          manuscript_id: manuscriptId,
          gateway_reference: reference,
          payment_type: spec.payment_type,
          amount_naira: ledgerNaira,
          status: "success",
          raw_webhook_payload: tx,
        },
      });

      if (gate === "GATE_1") {
        await transitionManuscript(db, manuscriptId, "DRAFT_PENDING_FEE1", "SUBMITTED", {}, { reason: "Gate 1 evaluation fee settled", metadata: { reference } });
        const scheduled = await scheduleAuditTx(db, { ...fresh, current_state: "SUBMITTED" }, { reason: "Stage 2 audit queued (24h window)" });
        // Legacy flags the existing UI reads
        await db.article.updateMany({ where: { submissions: { some: { id: fresh.submission_id } } }, data: { vetting_fee: true, vetting_reference: reference, vetting_currency: "NGN" } });
        await db.submission.update({ where: { id: fresh.submission_id }, data: { vetting_fee: true } });
        return { gate, ...scheduled, manuscriptId };
      }

      // GATE_2: split + referral commission + state, atomically.
      // Same four-way split for both tracks; Global Card is split in the same proportions.
      await db.gate2DistributionLedger.create({
        data: { manuscript_id: manuscriptId, payment_ledger_id: ledger.id, ...computeGate2Split(ledgerNaira) },
      });
      let referralCredited = false;
      if (fresh.referred_by_reviewer_id) {
        await db.referralPayoutLedger.create({
          data: {
            reviewer_id: fresh.referred_by_reviewer_id,
            manuscript_id: manuscriptId,
            amount_naira: FINANCIALS.REFERRAL_COMMISSION_NAIRA,
            status: "CREDITED",
          },
        });
        await db.reviewerProfile.update({
          where: { id: fresh.referred_by_reviewer_id },
          data: { wallet_balance_naira: { increment: FINANCIALS.REFERRAL_COMMISSION_NAIRA } },
        });
        referralCredited = true;
      }
      await transitionManuscript(db, manuscriptId, "AUDIT_PASSED_PENDING_APC", "APC_PAID", {}, { reason: "Gate 2 APC settled", metadata: { reference } });
      await db.article.updateMany({ where: { submissions: { some: { id: fresh.submission_id } } }, data: { processing_fee: true, processing_reference: reference, processing_currency: "NGN" } });
      await db.submission.update({ where: { id: fresh.submission_id }, data: { processing_fee: true } });
      return { gate, manuscriptId, referralCredited, track, splitRecorded: true };
    });

    if (result.revisionNo) {
      // After commit. If Redis is down the DB sweeper still picks the audit up on time.
      enqueueAudit(manuscriptId, result.revisionNo, result.scheduledFor).catch((e) =>
        console.error("[ijsds2] audit enqueue failed (sweeper will recover):", e.message),
      );
    }
    if (result.gate === "GATE_2") {
      createNotification({
        user_id: manuscript.author_id,
        title: "APC received",
        message: `Payment for "${manuscript.title}" received. Your manuscript now moves to reviewer matching.`,
        type: "success",
      }).catch(() => {});
    }
    return result;
  } catch (e) {
    // Lost a race on the unique index: someone else settled it first. Re-read and report.
    if (e.code === "P2002") return { alreadyProcessed: true };
    throw e;
  }
};

// ── Paystack webhook ────────────────────────────────────────────────────────────────

export const verifyWebhookSignature = (rawBody, signature) => {
  if (!signature) return false;
  const expected = crypto.createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const handleWebhookEvent = async (event) => {
  if (event?.event !== "charge.success") return { ignored: true };
  const data = event.data ?? {};
  const gate = field(data, "gate");
  const manuscriptId = field(data, "manuscript_id");
  // Gate 1 is paid before the submission exists in the current UI, so no manuscript_id
  // yet — that path is settled by POST /payments/verify once the manuscript is created.
  if (!gate || !manuscriptId || !data.reference) return { ignored: true, reason: "no manuscript binding" };
  return settlePayment({ reference: data.reference, gate, manuscriptId });
};
