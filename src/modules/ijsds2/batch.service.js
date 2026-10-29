import prisma from "../../config/prisma.js";
import { IN_PROGRESS_STATES, httpError, stateLabel } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { getCycle, getBatchTarget, volumeIssueFor } from "./calendar.js";
import { promoteReadyForRelease } from "./manuscripts.service.js";
import { markPublished } from "./similarity/fingerprints.service.js";
import { runPublishSideEffects } from "../articles/articles.service.js";

const BATCH_LOCK_KEY = 280_000_001; // pg advisory lock id for the monthly batch

export const getBatchStatus = async () => {
  const cycle = getCycle();
  const [ready, inProgress] = await Promise.all([
    prisma.manuscript.count({ where: { current_state: "READY_FOR_RELEASE" } }),
    prisma.manuscript.count({ where: { current_state: { in: [...IN_PROGRESS_STATES] } } }),
  ]);
  return { ...cycle, readyCount: ready, inProgressCount: inProgress };
};

/**
 * 28th-day batch (PRD §4.E). Publishes READY_FOR_RELEASE manuscripts one transaction each
 * (a bad paper never blocks the others) and leaves everything else untouched so it rolls
 * over. It NEVER invents a DOI: a paper without a Crossref-registered DOI is skipped and
 * reported, because DOIs are minted at Stage 6 and cannot be changed once deposited.
 */
export const executeMonthlyBatch = async ({ year, month, actor = null } = {}) => {
  const target = getBatchTarget();
  const targetYear = year ?? target.year;
  const targetMonth = month ?? target.month;

  // Transaction-scoped advisory lock held on one dedicated connection for the whole run
  // (session-level locks are unsafe with a connection pool). It releases automatically on
  // commit/rollback or if the process dies.
  return prisma.$transaction(async (lockTx) => {
    const [{ locked }] = await lockTx.$queryRaw`SELECT pg_try_advisory_xact_lock(${BATCH_LOCK_KEY}) AS locked`;
    if (!locked) throw httpError(409, "A publication batch is already running");
    await promoteReadyForRelease(); // anything whose DOI registered since the last sweep
    const candidates = await prisma.manuscript.findMany({
      where: { current_state: "READY_FOR_RELEASE" },
      select: { id: true, title: true, doi: true, submission: { select: { article_id: true, article: { select: { id: true, volume: true, issue: true, crossrefDoi: true, doi: true, crossref_registered_at: true } } } } },
    });

    const published = [];
    const skipped = [];

    for (const c of candidates) {
      const article = c.submission.article;
      const doi = article?.crossrefDoi ?? article?.doi ?? c.doi;
      if (!article || !doi) {
        skipped.push({ manuscriptId: c.id, reason: "No registered DOI (Stage 6 incomplete)" });
        continue;
      }
      if (article.crossrefDoi && !article.crossref_registered_at) {
        skipped.push({ manuscriptId: c.id, reason: "DOI deposited but not yet confirmed by Crossref" });
        continue;
      }
      try {
        await publishManuscript(c, article, doi, {
          targetYear, targetMonth, actor,
          reason: `Monthly batch ${targetYear}-${String(targetMonth).padStart(2, "0")}`,
        });
        published.push(c.id);
      } catch (e) {
        skipped.push({ manuscriptId: c.id, reason: e.message });
      }
    }

    const rolledOver = await prisma.manuscript.count({ where: { current_state: { in: [...IN_PROGRESS_STATES] } } });
    const result = { executedAt: new Date(), targetYear, targetMonth, publishedCount: published.length, rolledOverCount: rolledOver, publishedManuscriptIds: published, skipped };
    console.log("[ijsds2] monthly batch", JSON.stringify({ ...result, publishedManuscriptIds: undefined }));
    return result;
  }, { timeout: 15 * 60 * 1000, maxWait: 10_000 });
};

/** READY_FOR_RELEASE -> PUBLISHED for one manuscript, then the post-publication side effects. */
const publishManuscript = async (manuscript, article, doi, { targetYear, targetMonth, actor, reason, metadata }) => {
  // Volume/issue are baked into the DOI at Stage 6; publication must not contradict them.
  const vi = article.volume && article.issue ? { volume: article.volume, issue: article.issue } : volumeIssueFor(targetYear, targetMonth);
  const publishedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await transitionManuscript(
      tx, manuscript.id, "READY_FOR_RELEASE", "PUBLISHED",
      { published_at: publishedAt, doi, target_publication_year: targetYear, target_publication_month: targetMonth },
      { changedBy: actor?.id ?? null, reason, metadata },
    );
    await tx.article.update({ where: { id: article.id }, data: { status: "published", publication_date: publishedAt, volume: vi.volume, issue: vi.issue } });
  });
  markPublished(manuscript.id, article.id, manuscript.title).catch((e) => console.error("[ijsds2] fingerprint promote failed:", e.message));
  // After commit: emails, search-engine pings. Failures here never undo publication.
  runPublishSideEffects(article.id).catch((e) => console.error("[ijsds2] publish side-effects failed:", manuscript.id, e.message));
};

/**
 * Out-of-cycle release of a single article by an editor (e.g. a paper that just missed the 28th).
 * Same requirements as the batch: a Crossref-confirmed DOI and a finished production stage. The
 * editor's reason is kept in the workflow audit trail.
 */
export const releaseArticleNow = async ({ articleId, actor, reason }) => {
  reason = String(reason ?? "").trim();
  if (reason.length < 5) throw httpError(400, "Give a short reason for publishing outside the monthly release");

  let article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, status: true, volume: true, issue: true, crossrefDoi: true, doi: true, crossref_status: true, crossref_message: true, crossref_registered_at: true },
  });
  if (!article) throw httpError(404, "Article not found");
  if (article.status === "published") throw httpError(409, "This article is already published");

  // A deposit may have been confirmed since the last 10-minute check: ask Crossref now.
  if (article.crossrefDoi && !article.crossref_registered_at) {
    const { checkPendingDeposits } = await import("../crossRefDoi/cross.service.js");
    await checkPendingDeposits({ articleId });
    article = await prisma.article.findUnique({ where: { id: articleId }, select: { id: true, status: true, volume: true, issue: true, crossrefDoi: true, doi: true, crossref_status: true, crossref_message: true, crossref_registered_at: true } });
  }
  if (!article.crossrefDoi) throw httpError(409, "Register the Crossref DOI before publishing");
  if (!article.crossref_registered_at) {
    throw httpError(409, article.crossref_status === "FAILED"
      ? `Crossref rejected the DOI deposit: ${article.crossref_message ?? "see the DOI tab"}. Fix it and redeposit first.`
      : "The DOI has been deposited but Crossref has not confirmed it yet. Try again in a few minutes.");
  }

  const find = () => prisma.manuscript.findFirst({ where: { submission: { article_id: articleId } }, select: { id: true, title: true, current_state: true } });
  let manuscript = await find();
  if (!manuscript) throw httpError(409, "This article has no IJSDS 2.0 manuscript record; publish it from the article status instead");
  if (manuscript.current_state === "IN_PRODUCTION") {
    await promoteReadyForRelease({ articleId });
    manuscript = await find();
  }
  if (manuscript.current_state !== "READY_FOR_RELEASE") {
    throw httpError(409, `This paper is ${stateLabel(manuscript.current_state)}; it must finish production (approved for processing, DOI confirmed) before release.`);
  }

  const cycle = getCycle();
  await publishManuscript(manuscript, article, article.crossrefDoi, {
    targetYear: cycle.targetYear, targetMonth: cycle.targetMonth, actor,
    reason: `Early release: ${reason}`, metadata: { earlyRelease: true },
  });
  return { published: true, manuscriptId: manuscript.id, articleId };
};
