// Recreates the pgvector HNSW indexes after `prisma db push`.
//
// Prisma can't model HNSW indexes on vector columns, so `prisma db push` (run on every
// boot in start.sh) sees them as drift and DROPS them. Without them reviewer/citation
// similarity search still works but falls back to a slow sequential scan. Every statement
// is idempotent and this never throws: a failure must not stop the server from starting.

import pg from "pg";

const STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "idx_reviewer_vector" ON "reviewer_profiles" USING hnsw ("expertise_vector" vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS "idx_citation_context_vector" ON "manuscript_citations" USING hnsw ("citation_context_vector" vector_cosine_ops)`,
];

const run = async () => {
  if (!process.env.DATABASE_URL) return console.warn("[ensure-vector-indexes] DATABASE_URL not set — skipping");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 1,
  });
  try {
    for (const sql of STATEMENTS) await pool.query(sql);
    console.log("[ensure-vector-indexes] HNSW indexes present");
  } catch (err) {
    console.warn("[ensure-vector-indexes] skipped:", err.message);
  } finally {
    await pool.end().catch(() => {});
  }
};

run();
