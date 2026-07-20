// Reconciles the articles table with the Prisma schema.
//
// `prisma migrate deploy` skips any migration already recorded as applied in
// _prisma_migrations, even if its columns were never actually created (e.g. a
// partial run that was later resolved as applied). That left these five columns
// missing in production while Prisma believed the migration was done.
//
// Every statement is idempotent, so this is safe to run on every boot. It never
// throws: a failure here must not stop the server from starting.

import pg from "pg";

const STATEMENTS = [
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossrefDoi" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "articles_crossrefDoi_key" ON "articles"("crossrefDoi")`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "vetting_currency"     TEXT`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "vetting_reference"    TEXT`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "processing_currency"  TEXT`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "processing_reference" TEXT`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "indexing_fee" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "billing_track" TEXT DEFAULT 'local'`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "ai_consent" BOOLEAN`,
];

const run = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[ensure-columns] DATABASE_URL not set — skipping");
    return;
  }

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    console.log("[ensure-columns] articles table reconciled with schema");
  } catch (err) {
    console.error("[ensure-columns] failed (server will start anyway):", err.message);
  } finally {
    await client.end().catch(() => {});
  }
};

await run();
