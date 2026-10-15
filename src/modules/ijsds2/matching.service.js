import prisma from "../../config/prisma.js";
import { MAX_REVIEWER_LOAD, httpError, stateLabel } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { getOrCreateReviewerProfile } from "./manuscripts.service.js";
import { embed, isConfigured, toPgVector } from "./embeddings.js";
import { sendReviewAssignedEmail } from "../email/email.service.js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Stage 3 reviewer matching with the COPE conflict firewall.
 * Excluded: the referring reviewer (PRD §5), the manuscript's own author, reviewers
 * already invited, unavailable reviewers and reviewers at the load cap.
 *
 * Vector path (PRD SQL) is used when both vectors exist; otherwise a keyword fallback
 * with the SAME exclusions. `method` tells the caller which one produced the ranking.
 */
/** Best-effort: fills missing abstract/expertise vectors so the vector path can run. */
const ensureVectors = async (manuscriptId) => {
  if (!isConfigured()) return;
  try {
    const [m] = await prisma.$queryRaw`SELECT title, abstract, (abstract_vector IS NOT NULL) AS has FROM manuscripts WHERE id = ${manuscriptId}::uuid`;
    if (m && !m.has) {
      const v = toPgVector(await embed(`${m.title}\n${m.abstract}`));
      await prisma.$executeRaw`UPDATE manuscripts SET abstract_vector = ${v}::vector WHERE id = ${manuscriptId}::uuid`;
    }
    const missing = await prisma.$queryRaw`SELECT rp.id, rp.expertise_keywords, p.bio FROM reviewer_profiles rp JOIN profiles p ON p.id = rp.user_id WHERE rp.expertise_vector IS NULL AND (cardinality(rp.expertise_keywords) > 0 OR p.bio IS NOT NULL) LIMIT 50`;
    for (const r of missing) {
      const v = toPgVector(await embed(`${(r.expertise_keywords ?? []).join(", ")}\n${r.bio ?? ""}`));
      await prisma.$executeRaw`UPDATE reviewer_profiles SET expertise_vector = ${v}::vector WHERE id = ${r.id}::uuid`;
    }
  } catch (e) {
    console.warn("[ijsds2] embedding refresh skipped:", e.message);
  }
};

export const matchReviewers = async (manuscriptId, limit = 5) => {
  await ensureVectors(manuscriptId);
  const m = await prisma.manuscript.findUnique({ where: { id: manuscriptId }, select: { id: true, title: true, abstract: true, author_id: true, referred_by_reviewer_id: true, submission_id: true } });
  if (!m) throw httpError(404, "Manuscript not found");

  const invited = (await prisma.review.findMany({ where: { submission_id: m.submission_id }, select: { reviewer_id: true } })).map((r) => r.reviewer_id);

  const vectorRows = await prisma.$queryRaw`
    SELECT rp.id AS reviewer_id, rp.user_id,
           1 - (rp.expertise_vector <=> mm.abstract_vector) AS similarity_score
    FROM reviewer_profiles rp
    JOIN manuscripts mm ON mm.id = ${manuscriptId}::uuid
    WHERE rp.is_available = TRUE
      AND rp.active_load < ${MAX_REVIEWER_LOAD}
      AND rp.id != COALESCE(mm.referred_by_reviewer_id, ${ZERO_UUID}::uuid)
      AND rp.user_id != mm.author_id
      AND NOT (rp.user_id = ANY(${invited}::uuid[]))
      AND rp.expertise_vector IS NOT NULL
      AND mm.abstract_vector IS NOT NULL
    ORDER BY rp.expertise_vector <=> mm.abstract_vector
    LIMIT ${limit}`;

  const profileSelect = { id: true, user_id: true, expertise_keywords: true, active_load: true, user: { select: { full_name: true, email: true, affiliation: true } } };

  if (vectorRows.length) {
    const profiles = await prisma.reviewerProfile.findMany({ where: { id: { in: vectorRows.map((r) => r.reviewer_id) } }, select: profileSelect });
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return {
      method: "vector",
      candidates: vectorRows.map((r) => shape(byId.get(r.reviewer_id), Number(r.similarity_score))),
    };
  }

  const pool = await prisma.reviewerProfile.findMany({
    where: {
      is_available: true,
      active_load: { lt: MAX_REVIEWER_LOAD },
      user_id: { notIn: [m.author_id, ...invited] },
      ...(m.referred_by_reviewer_id ? { id: { not: m.referred_by_reviewer_id } } : {}),
    },
    select: profileSelect,
  });
  const text = `${m.title} ${m.abstract}`.toLowerCase();
  const scored = pool
    .map((p) => {
      const kws = p.expertise_keywords ?? [];
      const hits = kws.filter((k) => text.includes(k.toLowerCase())).length;
      return shape(p, kws.length ? hits / kws.length : 0);
    })
    .filter((c) => c.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.activeLoad - b.activeLoad)
    .slice(0, limit);
  return { method: "keyword", candidates: scored };
};

const shape = (p, similarity) => ({
  reviewerId: p.id,
  userId: p.user_id,
  fullName: p.user?.full_name ?? null,
  email: p.user?.email ?? null,
  affiliation: p.user?.affiliation ?? null,
  similarity: Number(similarity.toFixed(4)),
  expertiseKeywords: p.expertise_keywords ?? [],
  activeLoad: p.active_load,
});

/**
 * Assigns reviewers (by reviewer USER id): re-checks the COPE firewall at write time, bumps
 * workload atomically, creates the invitations and emails the reviewers. Reviewers without a
 * reviewer_profiles row get one, so everyone is subject to the firewall and the load cap.
 */
export const assignReviewers = async (manuscriptId, reviewerUserIds, actorId, { deadlineDays = 21 } = {}) => {
  if (!Array.isArray(reviewerUserIds) || !reviewerUserIds.length) throw httpError(400, "reviewerUserIds required");
  const profiles = [];
  for (const uid of [...new Set(reviewerUserIds)]) profiles.push(await getOrCreateReviewerProfile(uid));
  const deadline = new Date(Date.now() + deadlineDays * 86400000);

  const created = await prisma.$transaction(async (tx) => {
    const m = await tx.manuscript.findUnique({ where: { id: manuscriptId } });
    if (!m) throw httpError(404, "Manuscript not found");
    if (!["APC_PAID", "REVIEWER_MATCHED", "IN_PEER_REVIEW"].includes(m.current_state)) {
      throw httpError(409, `Reviewers can only be assigned once the audit is cleared and the Gate 2 publication fee is paid. This paper is: ${stateLabel(m.current_state)}.`);
    }

    const reviews = [];
    for (const rp of profiles) {
      // COPE firewall — enforced again at write time, not just when listing candidates.
      if (rp.id === m.referred_by_reviewer_id) throw httpError(409, "COPE conflict: the referring reviewer cannot review this manuscript");
      if (rp.user_id === m.author_id) throw httpError(409, "COPE conflict: a reviewer cannot review their own manuscript");

      const dup = await tx.review.findFirst({ where: { submission_id: m.submission_id, reviewer_id: rp.user_id } });
      if (dup) throw httpError(409, "Reviewer already invited to this manuscript");

      const bumped = await tx.reviewerProfile.updateMany({
        where: { id: rp.id, is_available: true, active_load: { lt: MAX_REVIEWER_LOAD } },
        data: { active_load: { increment: 1 } },
      });
      if (bumped.count !== 1) throw httpError(409, "Reviewer is unavailable or at the maximum active load");

      reviews.push(
        await tx.review.create({
          data: { submission_id: m.submission_id, reviewer_id: rp.user_id, invitation_status: "pending", invitation_sent_at: new Date(), deadline_date: deadline },
          include: { reviewer: { select: { id: true, full_name: true, email: true } } },
        }),
      );
    }

    if (m.current_state === "APC_PAID") {
      await transitionManuscript(tx, m.id, "APC_PAID", "REVIEWER_MATCHED", {}, { changedBy: actorId, reason: "Reviewers assigned" });
    }
    return { reviews, title: m.title, submissionId: m.submission_id };
  });

  for (const r of created.reviews) {
    if (r.reviewer?.email) {
      sendReviewAssignedEmail({
        to: r.reviewer.email,
        recipientId: r.reviewer.id,
        submissionId: created.submissionId,
        reviewerName: r.reviewer.full_name,
        title: created.title,
        deadline: deadline.toISOString().split("T")[0],
      }).catch((err) => console.error("[email] review_assigned:", err.message));
    }
  }
  return created.reviews.map(({ reviewer, ...r }) => r);
};

const INVITABLE_STATES = ["APC_PAID", "REVIEWER_MATCHED", "IN_PEER_REVIEW", "AUTHOR_REVISION_REQUESTED"];

/**
 * The COPE firewall for ANY way of inviting a reviewer (automated assignment or an editor's
 * manual invite). Returns normally when eligible, throws a 409 otherwise. Papers without a
 * manuscript row (pre-2.0 data) are not restricted.
 */
export const assertReviewerInvitable = async (db, submissionId, reviewerUserId) => {
  const m = await db.manuscript.findUnique({ where: { submission_id: submissionId } });
  if (!m) return null;
  if (!INVITABLE_STATES.includes(m.current_state)) {
    throw httpError(409, `Reviewers can only be invited after the audit is cleared and the Gate 2 publication fee (APC) is paid. This paper is: ${stateLabel(m.current_state)}.`);
  }
  if (reviewerUserId === m.author_id) throw httpError(409, "COPE conflict: a reviewer cannot review their own manuscript");
  if (m.referred_by_reviewer_id) {
    const rp = await db.reviewerProfile.findUnique({ where: { id: m.referred_by_reviewer_id }, select: { user_id: true } });
    if (rp?.user_id === reviewerUserId) throw httpError(409, "COPE conflict: the referring reviewer cannot review this manuscript");
  }
  return m;
};

/** Releases one unit of reviewer load (invitation declined / review submitted). */
export const releaseReviewerLoad = async (reviewUserId) => {
  await prisma.$executeRaw`UPDATE reviewer_profiles SET active_load = GREATEST(active_load - 1, 0) WHERE user_id = ${reviewUserId}::uuid`;
};

/** Counts a manual (editor-initiated) invitation against the reviewer's workload. */
export const acquireReviewerLoad = async (reviewUserId) => {
  await prisma.$executeRaw`UPDATE reviewer_profiles SET active_load = active_load + 1 WHERE user_id = ${reviewUserId}::uuid`;
};
