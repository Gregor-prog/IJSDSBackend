ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossref_status" VARCHAR(20);
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossref_batch_id" TEXT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossref_message" TEXT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossref_checked_at" TIMESTAMPTZ(6);
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossref_registered_at" TIMESTAMPTZ(6);

-- Existing DOIs are re-verified against Crossref's public records by the 10-minute sweep
-- (no batch id is known for them), instead of being assumed registered.
UPDATE "articles" SET "crossref_status" = 'PENDING' WHERE "crossrefDoi" IS NOT NULL AND "crossref_status" IS NULL;
