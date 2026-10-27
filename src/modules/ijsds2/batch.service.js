import prisma from "../../config/prisma.js";
import { IN_PROGRESS_STATES, httpError } from "./ijsds2.constants.js";
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
      // Volume/issue are baked into the DOI at Stage 6; the batch must not contradict them.
      const vi = article.volume && article.issue ? { volume: article.volume, issue: article.issue } : volumeIssueFor(targetYear, targetMonth);
      const publishedAt = new Date();

      try {
        await prisma.$transaction(async (tx) => {
          await transitionManuscript(
            tx, c.id, "READY_FOR_RELEASE", "PUBLISHED",
            { published_at: publishedAt, doi, target_publication_year: targetYear, target_publication_month: targetMonth },
            { changedBy: actor?.id ?? null, reason: `Monthly batch ${targetYear}-${String(targetMonth).padStart(2, "0")}` },
          );
          await tx.article.update({ where: { id: article.id }, data: { status: "published", publication_date: publishedAt, volume: vi.volume, issue: vi.issue } });
        });
        published.push(c.id);
        markPublished(c.id, article.id, c.title).catch((e) => console.error("[ijsds2] fingerprint promote failed:", e.message));
        // After commit: emails, search-engine pings. Failures here never undo publication.
        runPublishSideEffects(article.id).catch((e) => console.error("[ijsds2] publish side-effects failed:", c.id, e.message));
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
