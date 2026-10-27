import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { httpError, stateLabel, paymentGatesEnforced } from "./ijsds2.constants.js";
import { canTransition, transitionManuscript } from "./stateMachine.js";
import { getCycle } from "./calendar.js";

// ── Reviewer referral codes ─────────────────────────────────────────────────────────

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => {
  const bytes = crypto.randomBytes(6);
  return "IJSDS-" + [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
};

export const getOrCreateReviewerProfile = async (userId) => {
  const existing = await prisma.reviewerProfile.findUnique({ where: { user_id: userId } });
  if (existing) return existing;
  const profile = await prisma.profile.findUnique({ where: { id: userId }, select: { is_reviewer: true, role: true } });
  if (!profile || !(profile.is_reviewer || profile.role === "reviewer")) {
    throw httpError(403, "Only reviewers have a referral profile");
  }
  for (let i = 0; i < 5; i++) {
    try {
      return await prisma.reviewerProfile.create({ data: { user_id: userId, referral_code: makeCode() } });
    } catch (e) {
      if (e.code !== "P2002") throw e;
      const raced = await prisma.reviewerProfile.findUnique({ where: { user_id: userId } });
      if (raced) return raced; // concurrent request created it
    }
  }
  throw httpError(500, "Could not allocate a referral code");
};

export const findReviewerByCode = (code) =>
  code && String(code).trim()
    ? prisma.reviewerProfile.findUnique({ where: { referral_code: String(code).trim().toUpperCase() } })
    : null;

export const validateReferralCode = async (code, requesterId) => {
  const reviewer = await findReviewerByCode(code);
  // Same answer for "unknown" and "your own code" so the endpoint reveals nothing extra.
  return { valid: Boolean(reviewer && reviewer.user_id !== requesterId) };
};

// ── Manuscript lifecycle ────────────────────────────────────────────────────────────

/**
 * Creates the IJSDS 2.0 manuscript row for a freshly created submission. Runs inside the
 * submission transaction so the two can never diverge.
 */
export const createManuscriptForSubmission = async (tx, { submission, article, referralCode }) => {
  let referredBy = null;
  if (referralCode) {
    const reviewer = await tx.reviewerProfile.findUnique({
      where: { referral_code: String(referralCode).trim().toUpperCase() },
      select: { id: true, user_id: true },
    });
    // Self-referral is ignored (the referring reviewer is excluded from review anyway,
    // and would otherwise earn a commission on their own paper).
    if (reviewer && reviewer.user_id !== submission.submitter_id) referredBy = reviewer.id;
    else console.warn("[ijsds2] Ignoring unknown/self referral code on new submission");
  }

  return tx.manuscript.create({
    data: {
      submission_id: submission.id,
      title: article.title,
      abstract: article.abstract,
      author_id: submission.submitter_id,
      referred_by_reviewer_id: referredBy,
      raw_file_r2_key: article.manuscript_file_url ?? null,
    },
  });
};

export const getManuscriptBySubmission = (submissionId) =>
  prisma.manuscript.findUnique({ where: { submission_id: submissionId } });

export const assertCanView = (manuscript, user) => {
  const staff = user.is_admin || user.is_editor || user.role === "admin" || user.role === "editor";
  if (!staff && manuscript.author_id !== user.id) throw httpError(403, "Forbidden");
  return staff;
};

// ── Legacy article.status → manuscript state sync (editorial/production stages) ─────
// Stages 4-6 are still driven by the existing editorial UI which sets article.status.
// This keeps the PRD state machine authoritative: those stages can only be entered once
// Gate 2 is paid (APC_PAID or later), and nothing can reach PUBLISHED except the batch.

const PIPELINE = ["APC_PAID", "REVIEWER_MATCHED", "IN_PEER_REVIEW", "ACCEPTED", "IN_PRODUCTION", "READY_FOR_RELEASE"];
const LEGACY_TARGET = {
  under_review: "IN_PEER_REVIEW",
  accepted: "ACCEPTED",
  processed: "IN_PRODUCTION",
  ready_for_publication: "READY_FOR_RELEASE",
};

export const syncManuscriptWithArticleStatus = async (tx, articleId, legacyStatus, actorId = null) => {
  const target = LEGACY_TARGET[legacyStatus];
  if (!target) return null;

  const manuscript = await tx.manuscript.findFirst({ where: { submission: { article_id: articleId } } });
  if (!manuscript) return null; // pre-2.0 data with no manuscript row

  // Paid flags are the record of payment: settle any fee the flags already show before judging the stage.
  const { reconcileFromFlags } = await import("./flagReconciliation.service.js");
  await reconcileFromFlags(manuscript.id);
  const fresh = await tx.manuscript.findUnique({ where: { id: manuscript.id } });
  manuscript.current_state = fresh.current_state;

  const from = PIPELINE.indexOf(manuscript.current_state);
  const to = PIPELINE.indexOf(target);
  if (from === -1 && !paymentGatesEnforced()) {
    // Gates switched off: follow the editor's status directly, recorded in the audit trail, so the
    // paper can still reach READY_FOR_RELEASE and be published by the monthly batch.
    const extra = {};
    if (target === "READY_FOR_RELEASE") {
      const cycle = getCycle();
      extra.target_publication_year = cycle.targetYear;
      extra.target_publication_month = cycle.targetMonth;
    }
    await tx.manuscript.update({ where: { id: manuscript.id }, data: { current_state: target, ...extra } });
    await tx.workflowAuditLog.create({
      data: {
        submission_id: manuscript.submission_id,
        old_status: manuscript.current_state,
        new_status: target,
        changed_by: actorId,
        change_reason: `article.status=${legacyStatus} (payment gates off)`,
        metadata: { source: "ijsds2", gates: "off" },
      },
    });
    return target;
  }
  if (from === -1) {
    throw httpError(
      409,
      `This paper is ${stateLabel(manuscript.current_state)}. The integrity audit must be cleared and the Gate 2 publication fee (APC) paid before it can be marked "${legacyStatus.replace(/_/g, " ")}".`,
    );
  }
  if (to <= from) return manuscript; // already there or beyond (idempotent)

  let state = manuscript.current_state;
  for (const next of PIPELINE.slice(from + 1, to + 1)) {
    if (!canTransition(state, next)) throw httpError(409, `Cannot move manuscript ${state} -> ${next}`);
    const extra = {};
    if (next === "READY_FOR_RELEASE") {
      // Stage 6 targets the batch that will publish it; volume/issue (and thus the DOI)
      // are derived from this cycle, so it must be fixed here, not at release time.
      const cycle = getCycle();
      extra.target_publication_year = cycle.targetYear;
      extra.target_publication_month = cycle.targetMonth;
    }
    await transitionManuscript(tx, manuscript.id, state, next, extra, { changedBy: actorId, reason: `article.status=${legacyStatus}` });
    state = next;
  }
  return state;
};

/**
 * Stage 6 -> release queue. A paper is ready for the 28th batch once it is IN_PRODUCTION and
 * its Crossref DOI has been registered (DOIs need volume/issue, so this also proves the
 * editor completed "Approve for Processing"). Idempotent; call with an articleId to promote
 * just that paper right after its DOI registers, or without to sweep everything.
 */
export const promoteReadyForRelease = async ({ articleId } = {}) => {
  const candidates = await prisma.manuscript.findMany({
    where: {
      current_state: "IN_PRODUCTION",
      // Only DOIs Crossref has confirmed (not merely deposited) count.
      submission: { article: { crossrefDoi: { not: null }, crossref_registered_at: { not: null }, ...(articleId ? { id: articleId } : {}) } },
    },
    select: { id: true },
  });
  const cycle = getCycle();
  let promoted = 0;
  for (const m of candidates) {
    try {
      await prisma.$transaction((tx) =>
        transitionManuscript(
          tx, m.id, "IN_PRODUCTION", "READY_FOR_RELEASE",
          { target_publication_year: cycle.targetYear, target_publication_month: cycle.targetMonth },
          { reason: "Crossref DOI registered — queued for the monthly batch" },
        ),
      );
      promoted++;
    } catch (e) {
      if (e.status !== 409) console.error("[ijsds2] promote failed:", m.id, e.message); // 409 = raced, fine
    }
  }
  return promoted;
};
