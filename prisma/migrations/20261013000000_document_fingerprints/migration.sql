CREATE TABLE "document_fingerprints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" VARCHAR(20) NOT NULL,
  "article_id" UUID,
  "manuscript_id" UUID,
  "title" TEXT,
  "hashes" BIGINT[],
  "word_count" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_fingerprints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_fingerprints_kind_check" CHECK ("kind" IN ('PUBLISHED','SUBMISSION'))
);
CREATE UNIQUE INDEX "document_fingerprints_article_id_key" ON "document_fingerprints"("article_id");
CREATE UNIQUE INDEX "document_fingerprints_manuscript_id_key" ON "document_fingerprints"("manuscript_id");
CREATE INDEX "document_fingerprints_hashes_idx" ON "document_fingerprints" USING GIN ("hashes");
