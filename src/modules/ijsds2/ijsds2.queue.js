import { Queue, Worker } from "bullmq";
import prisma from "../../config/prisma.js";
import { makeRedisConnection } from "../../lib/queue.js";

// Stage 2 audit queue + schedulers. The database is authoritative; Redis only delivers
// the work on time. A sweeper re-derives due work from Postgres, so a flushed/lost Redis
// can never strand a paid manuscript in IN_AUDIT.

const AUDIT_QUEUE = "ijsds2-audits";
const MAINTENANCE_QUEUE = "ijsds2-maintenance";
const ATTEMPTS = 5;
const STALE_RUNNING_MS = 30 * 60 * 1000;
const INLINE_PER_SWEEP = 5;
const INLINE_RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;

const connection = makeRedisConnection();
connection.on("error", (e) => console.error("[ijsds2-redis]", e.message));

const auditQueue = new Queue(AUDIT_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: ATTEMPTS,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});
const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: makeRedisConnection() });

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

export const enqueueAudit = async (manuscriptId, revisionNo, runAt, { unique = false } = {}) => {
  const delay = Math.max(0, new Date(runAt).getTime() - Date.now());
  const jobId = `audit-${manuscriptId}-${revisionNo}${unique ? `-${Date.now()}` : ""}`;
  await withTimeout(auditQueue.add("audit", { manuscriptId, revisionNo }, { jobId, delay }), 5000, "audit enqueue");
};

// ── Processors ──────────────────────────────────────────────────────────────────────

const processAudit = async (job) => {
  const { runIntegrityAudit } = await import("./audit.service.js");
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? ATTEMPTS);
  try {
    return await runIntegrityAudit({ ...job.data, isFinalAttempt });
  } catch (e) {
    if (isFinalAttempt) {
      // Unexpected crash on the last attempt: leave an explicit, visible failure.
      await prisma.manuscriptIntegrityAudit.updateMany({
        where: { manuscript_id: job.data.manuscriptId, revision_no: job.data.revisionNo, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", requires_human_review: true, last_error: e.message.slice(0, 500) },
      });
    }
    throw e;
  }
};

/** Re-derives due work from the database (idempotent). */
export const sweepDueAudits = async () => {
  const { scheduleAuditTx } = await import("./audit.service.js");
  const now = new Date();

  // Reset audits whose worker died mid-run.
  await prisma.manuscriptIntegrityAudit.updateMany({
    where: { status: "RUNNING", started_at: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
    data: { status: "QUEUED" },
  });

  // SUBMITTED manuscripts whose Gate 1 is already settled but that were never queued
  // (legacy backfill) enter the audit pipeline now.
  const orphans = await prisma.manuscript.findMany({ where: { current_state: "SUBMITTED" }, take: 50 });
  for (const m of orphans) {
    await prisma.$transaction((tx) => scheduleAuditTx(tx, m, { reason: "Backfilled legacy submission entering Stage 2" })).catch((e) =>
      console.error("[ijsds2] sweep schedule failed:", m.id, e.message),
    );
  }

  const { purgeExpiredRevocations } = await import("../auth/auth.service.js");
  await purgeExpiredRevocations().catch((e) => console.error("[auth] purge revocations failed:", e.message));
  const { reconcileAllFromFlags } = await import("./flagReconciliation.service.js");
  const reconciled = await reconcileAllFromFlags(); // paid flag but state still waiting -> follow the flag
  const { checkPendingDeposits } = await import("../crossRefDoi/cross.service.js");
  await checkPendingDeposits().catch((e) => console.error("[crossref] confirmation sweep failed:", e.message));
  const { promoteReadyForRelease } = await import("./manuscripts.service.js");
  const promoted = await promoteReadyForRelease();

  const due = await prisma.manuscriptIntegrityAudit.findMany({
    where: { status: "QUEUED", manuscript: { current_state: "IN_AUDIT", audit_scheduled_for: { lte: now } } },
    select: { manuscript_id: true, revision_no: true, manuscript: { select: { audit_scheduled_for: true } } },
    take: 100,
  });
  // Due by the DATABASE means run now. Don't hand it to the queue: the job created at payment
  // time is still sitting in Redis with its original 24h delay, and re-adding the same jobId is a
  // silent no-op, so an audit whose time was moved earlier would never start. The audit claim
  // (QUEUED -> RUNNING) makes this safe if the delayed job fires later too: it finds nothing to do.
  let inline = 0;
  const { runIntegrityAudit } = await import("./audit.service.js");
  for (const d of due) {
    if (inline >= INLINE_PER_SWEEP) break; // keep one sweep bounded; the rest go next sweep
    inline++;
    const overdueMs = now.getTime() - new Date(d.manuscript.audit_scheduled_for).getTime();
    await runIntegrityAudit({
      manuscriptId: d.manuscript_id,
      revisionNo: d.revision_no,
      // transient provider errors leave it QUEUED for the next sweep; after 2h overdue -> editor
      isFinalAttempt: overdueMs > INLINE_RETRY_WINDOW_MS,
    }).catch((err) => console.error(`[ijsds2] audit attempt failed (next sweep retries): ${err.message}`));
  }
  if (due.length) console.log(`[ijsds2] sweep: ${due.length} audit(s) due, ran ${inline}`);
  return { due: due.length, inline, backfilled: orphans.length, promoted, reconciled };
};

const processMaintenance = async (job) => {
  if (job.name === "sweep-audits") return sweepDueAudits();
  if (job.name === "monthly-batch") {
    const { executeMonthlyBatch } = await import("./batch.service.js");
    return executeMonthlyBatch({ actor: null });
  }
};

let started = false;
export const startIjsds2Workers = async () => {
  if (started) return;
  started = true;

  const auditWorker = new Worker(AUDIT_QUEUE, processAudit, { connection: makeRedisConnection(), concurrency: 2 });
  auditWorker.on("failed", (job, err) => console.error(`[ijsds2] audit job ${job?.id} failed:`, err.message));
  auditWorker.on("error", (err) => console.error("[ijsds2] audit worker error:", err.message));

  // Long lock: a sweep may run several audits (CORE/Crossref lookups take minutes).
  const maint = new Worker(MAINTENANCE_QUEUE, processMaintenance, { connection: makeRedisConnection(), concurrency: 1, lockDuration: 15 * 60 * 1000 });
  maint.on("failed", (job, err) => console.error(`[ijsds2] ${job?.name} failed:`, err.message));
  maint.on("error", (err) => console.error("[ijsds2] maintenance worker error:", err.message));

  // Schedulers are upserted by id, so N instances starting up still yield one schedule.
  await maintenanceQueue.upsertJobScheduler("sweep-audits", { every: 10 * 60 * 1000 }, { name: "sweep-audits" });
  // Each deploy restarts the 10-minute clock, so also sweep shortly after boot (no Redis needed).
  setTimeout(() => sweepDueAudits().catch((e) => console.error("[ijsds2] boot sweep failed:", e.message)), 60_000).unref();
  // 00:00 on the 28th, Lagos time (WAT, UTC+1, no DST). Cutoff 23:59 the 27th is implicit.
  await maintenanceQueue.upsertJobScheduler("monthly-batch", { pattern: "0 0 28 * *", tz: "Africa/Lagos" }, { name: "monthly-batch" });
  console.log("[ijsds2] audit worker + schedulers started");
};
