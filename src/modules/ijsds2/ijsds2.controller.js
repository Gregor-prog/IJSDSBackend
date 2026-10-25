import prisma from "../../config/prisma.js";
import { httpError, paymentGatesEnforced } from "./ijsds2.constants.js";
import { getCycle } from "./calendar.js";
import {
  assertCanView,
  getOrCreateReviewerProfile,
  validateReferralCode,
  getManuscriptBySubmission,
} from "./manuscripts.service.js";
import { reconcileFromFlags } from "./flagReconciliation.service.js";
import { settlePayment, verifyWebhookSignature, handleWebhookEvent } from "./payments.service.js";
import { buildAuthorReport, resolveAudit, requeueAudit, scheduleAuditTx } from "./audit.service.js";
import { enqueueAudit } from "./ijsds2.queue.js";
import { matchReviewers, assignReviewers } from "./matching.service.js";
import { executeMonthlyBatch, getBatchStatus } from "./batch.service.js";
import { submitAuthorRevision } from "./revisions.service.js";
import { requestWithdrawal, listMyWithdrawals, listWithdrawals, processWithdrawal } from "./withdrawals.service.js";
import { getActiveConfig, updateConfig, listConfigHistory } from "./integrity.config.js";

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req, res);
    if (data !== undefined) res.status(200).json({ success: true, data });
  } catch (e) {
    next(e);
  }
};

const isStaff = (u) => u.is_admin || u.is_editor || u.role === "admin" || u.role === "editor";

const loadManuscript = async (id, user) => {
  const m = await prisma.manuscript.findUnique({ where: { id } });
  if (!m) throw httpError(404, "Manuscript not found");
  const staff = assertCanView(m, user);
  return { m, staff };
};

// Public: the cycle banner is shown to anonymous visitors too.
export const cycle = wrap(async () => getCycle());

export const validateReferral = wrap(async (req) => validateReferralCode(req.body?.code, req.user.id));

export const myReviewerProfile = wrap(async (req) => {
  const p = await getOrCreateReviewerProfile(req.user.id);
  return {
    referral_code: p.referral_code,
    wallet_balance_naira: Number(p.wallet_balance_naira),
    active_load: p.active_load,
    is_available: p.is_available,
    expertise_keywords: p.expertise_keywords,
  };
});

export const updateMyReviewerProfile = wrap(async (req) => {
  await getOrCreateReviewerProfile(req.user.id);
  const { is_available, expertise_keywords } = req.body ?? {};
  const data = {};
  if (typeof is_available === "boolean") data.is_available = is_available;
  if (Array.isArray(expertise_keywords)) data.expertise_keywords = expertise_keywords.map(String).slice(0, 30);
  const p = await prisma.reviewerProfile.update({ where: { user_id: req.user.id }, data });
  return { is_available: p.is_available, expertise_keywords: p.expertise_keywords };
});

export const myReferrals = wrap(async (req) => {
  const p = await getOrCreateReviewerProfile(req.user.id);
  const rows = await prisma.referralPayoutLedger.findMany({ where: { reviewer_id: p.id }, orderBy: { created_at: "desc" }, take: 100 });
  return rows.map((r) => ({ id: r.id, amount_naira: Number(r.amount_naira), status: r.status, created_at: r.created_at }));
});

// ── Payments ────────────────────────────────────────────────────────────────────────

export const verifyPayment = wrap(async (req) => {
  const { reference, gate, manuscriptId, submissionId } = req.body ?? {};
  let id = manuscriptId;
  if (!id && submissionId) id = (await getManuscriptBySubmission(submissionId))?.id;
  if (!id) throw httpError(400, "manuscriptId or submissionId is required");
  const r = await settlePayment({ reference, gate, manuscriptId: id, payerUserId: req.user.id });
  if (r.needsReview) throw httpError(409, `Payment received but the manuscript is in state ${r.state}; the editorial office has been flagged to reconcile it.`);
  return r;
});

// Mounted with express.raw(): req.body is a Buffer.
export const paystackWebhook = async (req, res, next) => {
  try {
    if (!verifyWebhookSignature(req.body, req.headers["x-paystack-signature"])) {
      return res.status(401).json({ success: false, message: "Invalid signature" });
    }
    const result = await handleWebhookEvent(JSON.parse(req.body.toString("utf8")));
    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    // 4xx = permanent for this event (don't make Paystack retry it forever); 5xx retries.
    if (e.status && e.status < 500) return res.status(200).json({ success: false, message: e.message });
    next(e);
  }
};

// ── Manuscripts / audits ────────────────────────────────────────────────────────────

export const manuscriptBySubmission = wrap(async (req) => {
  let m = await getManuscriptBySubmission(req.params.submissionId);
  if (!m) throw httpError(404, "No IJSDS 2.0 manuscript for this submission");
  // The paid flags are the record of payment: make sure the workflow state agrees with them.
  if ((await reconcileFromFlags(m.id)).length) m = await getManuscriptBySubmission(req.params.submissionId);
  const { staff } = await loadManuscript(m.id, req.user);
  const audits = await prisma.manuscriptIntegrityAudit.findMany({
    where: { manuscript_id: m.id },
    orderBy: { revision_no: "desc" },
    select: { id: true, revision_no: true, status: true, decision: true, completed_at: true, requires_human_review: true },
  });
  return {
    id: m.id,
    current_state: m.current_state,
    audit_scheduled_for: m.audit_scheduled_for,
    audit_completed_at: m.audit_completed_at,
    audit_revision_count: m.audit_revision_count,
    target_publication_year: m.target_publication_year,
    target_publication_month: m.target_publication_month,
    published_at: m.published_at,
    doi: m.doi,
    payment_gates_enforced: paymentGatesEnforced(),
    // Authors never see MANUAL_REVIEW internals — it reads as "in progress".
    audits: audits.map((a) => ({ ...a, status: !staff && a.status === "MANUAL_REVIEW" ? "RUNNING" : a.status, requires_human_review: staff ? a.requires_human_review : undefined })),
  };
});

export const auditReport = wrap(async (req) => {
  const audit = await prisma.manuscriptIntegrityAudit.findUnique({ where: { id: req.params.auditId }, select: { id: true, manuscript_id: true, status: true } });
  if (!audit) throw httpError(404, "Audit not found");
  const { staff } = await loadManuscript(audit.manuscript_id, req.user);
  if (!staff && audit.status !== "COMPLETED") throw httpError(409, "The audit report is not ready yet");
  return buildAuthorReport(audit.id, { staff });
});

export const latestAuditReport = wrap(async (req) => {
  const { staff } = await loadManuscript(req.params.id, req.user);
  const audit = await prisma.manuscriptIntegrityAudit.findFirst({
    where: { manuscript_id: req.params.id, ...(staff ? {} : { status: "COMPLETED" }) },
    orderBy: { revision_no: "desc" },
    select: { id: true },
  });
  if (!audit) throw httpError(404, "No completed audit yet");
  return buildAuthorReport(audit.id, { staff });
});

/** Free revision upload (no new Gate 1) — re-triggers a new versioned Stage 2 run. */
export const uploadRevision = wrap(async (req) => {
  const { m } = await loadManuscript(req.params.id, req.user);
  if (m.author_id !== req.user.id) throw httpError(403, "Only the author can upload a revision");
  if (m.current_state !== "AUDIT_REVISION_REQUESTED") throw httpError(409, `Revisions are only accepted in AUDIT_REVISION_REQUESTED (state is ${m.current_state})`);
  if (!req.manuscript_file_url) throw httpError(400, "A manuscript file (.pdf/.docx) is required");

  const sched = await prisma.$transaction(async (tx) => {
    await tx.manuscript.update({ where: { id: m.id }, data: { raw_file_r2_key: req.manuscript_file_url } });
    await tx.article.updateMany({ where: { submissions: { some: { id: m.submission_id } } }, data: { manuscript_file_url: req.manuscript_file_url } });
    return scheduleAuditTx(tx, m, { actorId: req.user.id, reason: "Revision uploaded (no new Gate 1 fee)" });
  });
  enqueueAudit(m.id, sched.revisionNo, sched.scheduledFor).catch((e) => console.error("[ijsds2] enqueue failed (sweeper will recover):", e.message));
  return { manuscriptId: m.id, revisionNo: sched.revisionNo, auditScheduledFor: sched.scheduledFor };
});

export const reviewQueue = wrap(async () => {
  const rows = await prisma.manuscriptIntegrityAudit.findMany({
    where: { status: { in: ["MANUAL_REVIEW", "FAILED"] }, manuscript: { current_state: "IN_AUDIT" } },
    orderBy: { created_at: "asc" },
    select: {
      id: true, revision_no: true, status: true, requires_human_review: true, policy_rules_hit: true, last_error: true, created_at: true,
      manuscript: { select: { id: true, title: true, submission_id: true } },
    },
  });
  return rows;
});

export const resolve = wrap(async (req) => resolveAudit(req.params.auditId, req.body ?? {}, req.user));

export const requeue = wrap(async (req) => {
  const { manuscriptId, revisionNo } = await requeueAudit(req.params.auditId);
  await enqueueAudit(manuscriptId, revisionNo, new Date(), { unique: true }).catch((e) => console.error("[ijsds2] requeue enqueue failed (sweeper will recover):", e.message));
  return { queued: true };
});

export const selectRecommendation = wrap(async (req) => {
  const rec = await prisma.citationRecommendation.findUnique({ where: { id: req.params.id } });
  if (!rec) throw httpError(404, "Recommendation not found");
  const { m } = await loadManuscript(rec.manuscript_id, req.user);
  if (m.author_id !== req.user.id) throw httpError(403, "Forbidden");
  const updated = await prisma.citationRecommendation.update({ where: { id: rec.id }, data: { selected_by_author: Boolean(req.body?.selected) } });
  return { id: updated.id, selected: updated.selected_by_author };
});

const DISPOSITIONS = ["ACCEPTED_WARNING", "CORRECTED", "DISMISSED"];
export const dispositionCitation = wrap(async (req) => {
  const c = await prisma.manuscriptCitation.findUnique({ where: { id: req.params.id } });
  if (!c) throw httpError(404, "Citation not found");
  await loadManuscript(c.manuscript_id, req.user);
  if (!DISPOSITIONS.includes(req.body?.disposition)) throw httpError(400, `disposition must be one of ${DISPOSITIONS.join(", ")}`);
  await prisma.manuscriptCitation.update({ where: { id: c.id }, data: { disposition: req.body.disposition } });
  return { id: c.id, disposition: req.body.disposition };
});

// ── Reviewer matching ───────────────────────────────────────────────────────────────

export const match = wrap(async (req) => {
  const bySubmission = await getManuscriptBySubmission(req.params.id);
  const id = bySubmission?.id ?? req.params.id;
  return matchReviewers(id, Math.min(Number(req.query.limit) || 5, 20));
});

export const assign = wrap(async (req) => {
  const bySubmission = await getManuscriptBySubmission(req.params.id);
  const id = bySubmission?.id ?? req.params.id;
  await reconcileFromFlags(id);
  return assignReviewers(id, req.body?.reviewerUserIds, req.user.id);
});

// ── Batch & config ──────────────────────────────────────────────────────────────────

export const batchStatus = wrap(async () => getBatchStatus());
export const batchExecute = wrap(async (req) => {
  const { year, month } = req.body ?? {};
  if ((year && !Number.isInteger(year)) || (month && (!Number.isInteger(month) || month < 1 || month > 12))) throw httpError(400, "Invalid year/month");
  return executeMonthlyBatch({ year, month, actor: req.user });
});

export const getConfig = wrap(async () => ({ active: await getActiveConfig(), history: await listConfigHistory() }));
export const putConfig = wrap(async (req) => updateConfig(req.body?.config ?? {}, { userId: req.user.id, reason: req.body?.reason }));

export const authorRevision = wrap(async (req) => submitAuthorRevision(req.params.id, req.user, req.manuscript_file_url, req.body?.note));

export const withdrawalRequest = wrap(async (req) => requestWithdrawal(req.user.id, req.body ?? {}));
export const myWithdrawals = wrap(async (req) => listMyWithdrawals(req.user.id));
export const allWithdrawals = wrap(async (req) => listWithdrawals(req.query.status));
export const withdrawalProcess = wrap(async (req) => processWithdrawal(req.params.id, req.body ?? {}, req.user));

export { isStaff };
