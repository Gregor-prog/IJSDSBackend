-- Add columns that exist in the Prisma schema but were never migrated

-- CrossRef DOI (unique, nullable)
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "crossrefDoi" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "articles_crossrefDoi_key" ON "articles"("crossrefDoi");

-- Payment detail columns
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "vetting_currency"     TEXT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "vetting_reference"    TEXT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "processing_currency"  TEXT;
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "processing_reference" TEXT;

-- Indexing fee flag
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "indexing_fee" BOOLEAN NOT NULL DEFAULT false;
