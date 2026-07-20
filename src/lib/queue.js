import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";

// ── Redis connection ───────────────────────────────────────────────────────────
// BullMQ requires a dedicated ioredis connection (not the shared app one).
// In production set REDIS_URL; falls back to localhost for local dev.

const makeRedisConnection = () => {
  const url = process.env.REDIS_URL;

  if (url) {
    return new IORedis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
    });
  }

  return new IORedis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
};

// Shared connection reused by Queue, Worker, and QueueEvents
const connection = makeRedisConnection();

connection.on("error", (err) =>
  console.error("[redis] Connection error:", err.message)
);
connection.on("connect", () => console.log("[redis] Connected"));

// ── Queue definition ──────────────────────────────────────────────────────────

const CROSSREF_QUEUE = "crossref-submissions";

const crossRefQueue = new Queue(CROSSREF_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 10_000, // 10s, 20s, 40s, 80s, 160s
    },
    removeOnComplete: { count: 200 }, // keep last 200 completed jobs
    removeOnFail: { count: 500 },     // keep last 500 failed jobs for audit
  },
});

// ── Job types ─────────────────────────────────────────────────────────────────
// Each job payload: { articleId: string, type: "register" | "redeposit" }

// How long to wait for Redis to accept a job before giving up and depositing
// inline. BullMQ needs maxRetriesPerRequest: null, so when Redis is fully down
// `queue.add()` buffers the command and hangs rather than rejecting — this
// timeout is what turns that hang into a fallback.
const QUEUE_ADD_TIMEOUT_MS = 5_000;

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);

// Runs the actual CrossRef deposit without the queue. Lazy import mirrors the
// worker, avoiding the queue↔service circular dependency at module load.
const runDepositInline = async (articleId, type) => {
  const { registerDoi, reDepositDoi } = await import(
    "../modules/crossRefDoi/cross.service.js"
  );
  return type === "redeposit"
    ? reDepositDoi({ articleId })
    : registerDoi({ articleId });
};

export const enqueueCrossRefDeposit = async (articleId, type = "register") => {
  const jobId = `crossref-${type}-${articleId}-${Date.now()}`;

  try {
    const job = await withTimeout(
      crossRefQueue.add(type, { articleId, type }, { jobId }),
      QUEUE_ADD_TIMEOUT_MS,
      "queue.add"
    );
    console.log(`[queue] Enqueued CrossRef ${type} job ${job.id} for article ${articleId}`);
    return { jobId: job.id, queued: true };
  } catch (err) {
    // Redis unavailable or over quota — deposit inline so the DOI still gets
    // registered. Fire-and-forget: never block the caller on a CrossRef HTTP
    // round-trip. registerDoi is guarded by a crossrefDoi-already-set check, so
    // if the queued job later flushes too, the duplicate aborts safely.
    console.error(
      `[queue] Enqueue failed for article ${articleId} (${err.message}) — falling back to inline CrossRef ${type}`
    );

    runDepositInline(articleId, type)
      .then((r) =>
        console.log(`[queue] Inline CrossRef ${type} succeeded for article ${articleId} — DOI: ${r?.doi ?? "n/a"}`)
      )
      .catch((e) =>
        console.error(`[queue] Inline CrossRef ${type} failed for article ${articleId}: ${e.message}`)
      );

    return { jobId: null, queued: false, fallback: true };
  }
};

// ── Worker ────────────────────────────────────────────────────────────────────
// Lazily imported to avoid circular dep (service imports queue, queue imports service)

let workerStarted = false;

export const startCrossRefWorker = () => {
  if (workerStarted) return;
  workerStarted = true;

  const worker = new Worker(
    CROSSREF_QUEUE,
    async (job) => {
      const { articleId, type } = job.data;

      console.log(`[worker] Processing CrossRef ${type} job ${job.id} — article ${articleId}`);

      // Lazy import to avoid circular dependency at module load time
      const { registerDoi, reDepositDoi } = await import(
        "../modules/crossRefDoi/cross.service.js"
      );

      if (type === "redeposit") {
        return reDepositDoi({ articleId });
      }
      return registerDoi({ articleId });
    },
    {
      connection: makeRedisConnection(), // worker needs its own connection
      concurrency: 2,                    // process 2 jobs at a time max
    }
  );

  // ── Worker event hooks ─────────────────────────────────────────────────────

  worker.on("completed", (job, result) => {
    console.log(
      `[worker] CrossRef job ${job.id} completed — DOI: ${result?.doi ?? "n/a"}`
    );
  });

  worker.on("failed", (job, err) => {
    const attemptsLeft = (job?.opts?.attempts ?? 5) - (job?.attemptsMade ?? 0);
    console.error(
      `[worker] CrossRef job ${job?.id} failed (${attemptsLeft} retries left): ${err.message}`
    );
  });

  worker.on("error", (err) => {
    console.error("[worker] Worker error:", err.message);
  });

  console.log("[worker] CrossRef submission worker started");
  return worker;
};

// ── Queue event monitoring (optional — useful for admin endpoints) ─────────────

const queueEvents = new QueueEvents(CROSSREF_QUEUE, { connection: makeRedisConnection() });

queueEvents.on("waiting", ({ jobId }) =>
  console.log(`[queue] Job ${jobId} waiting`)
);
queueEvents.on("active", ({ jobId }) =>
  console.log(`[queue] Job ${jobId} active`)
);
queueEvents.on("stalled", ({ jobId }) =>
  console.warn(`[queue] Job ${jobId} stalled — will be retried`)
);

// ── Job status helper ─────────────────────────────────────────────────────────

export const getJobStatus = async (jobId) => {
  const job = await crossRefQueue.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    jobId: job.id,
    state,            // waiting | active | completed | failed | delayed
    attemptsMade: job.attemptsMade,
    data: job.data,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
    timestamp: new Date(job.timestamp).toISOString(),
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
};

export default crossRefQueue;
