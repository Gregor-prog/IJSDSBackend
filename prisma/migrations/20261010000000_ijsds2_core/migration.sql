-- IJSDS 2.0 core architecture (PRD v2.4.0-PROD) on the Express/Prisma backend.
-- Replaces the Supabase-only migration (supabase/migrations/20261005140000_*) that
-- referenced auth.users and relied on RLS: the API is now the only writer.
-- Requires the pgvector extension to be allow-listed on the managed Postgres.

CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TYPE "manuscript_state" AS ENUM (
  'DRAFT_PENDING_FEE1','SUBMITTED','IN_AUDIT','AUDIT_REJECTED',
  'AUDIT_REVISION_REQUESTED','AUDIT_PASSED_PENDING_APC','APC_PAID',
  'REVIEWER_MATCHED','IN_PEER_REVIEW','AUTHOR_REVISION_REQUESTED',
  'ACCEPTED','IN_PRODUCTION','READY_FOR_RELEASE','PUBLISHED'
);
CREATE TYPE "audit_run_status" AS ENUM ('QUEUED','RUNNING','COMPLETED','FAILED','MANUAL_REVIEW');
CREATE TYPE "citation_resolution_status" AS ENUM ('VALIDATED','PARTIAL_MATCH','UNRESOLVED','METADATA_MISMATCH');

CREATE TABLE "reviewer_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "referral_code" VARCHAR(20) NOT NULL,
  "wallet_balance_naira" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "expertise_keywords" TEXT[],
  "expertise_vector" vector(1536),
  "is_available" BOOLEAN NOT NULL DEFAULT true,
  "active_load" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reviewer_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_reviewer_wallet_nonneg" CHECK ("wallet_balance_naira" >= 0),
  CONSTRAINT "chk_reviewer_load_nonneg" CHECK ("active_load" >= 0)
);
CREATE UNIQUE INDEX "reviewer_profiles_user_id_key" ON "reviewer_profiles"("user_id");
CREATE UNIQUE INDEX "reviewer_profiles_referral_code_key" ON "reviewer_profiles"("referral_code");
CREATE INDEX "idx_reviewer_vector" ON "reviewer_profiles" USING hnsw ("expertise_vector" vector_cosine_ops);
ALTER TABLE "reviewer_profiles" ADD CONSTRAINT "reviewer_profiles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "manuscripts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "submission_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "abstract" TEXT NOT NULL,
  "author_id" UUID NOT NULL,
  "referred_by_reviewer_id" UUID,
  "current_state" "manuscript_state" NOT NULL DEFAULT 'DRAFT_PENDING_FEE1',
  "raw_file_r2_key" TEXT,
  "parsed_payload" JSONB NOT NULL DEFAULT '{}',
  "abstract_vector" vector(1536),
  "doi" TEXT,
  "audit_scheduled_for" TIMESTAMPTZ(6),
  "audit_completed_at" TIMESTAMPTZ(6),
  "target_publication_year" INTEGER,
  "target_publication_month" INTEGER,
  "published_at" TIMESTAMPTZ(6),
  "audit_revision_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manuscripts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manuscripts_submission_id_key" ON "manuscripts"("submission_id");
CREATE UNIQUE INDEX "manuscripts_doi_key" ON "manuscripts"("doi");
CREATE INDEX "manuscripts_current_state_idx" ON "manuscripts"("current_state");
CREATE INDEX "manuscripts_author_id_idx" ON "manuscripts"("author_id");
CREATE INDEX "idx_manuscripts_batch"
  ON "manuscripts"("target_publication_year","target_publication_month","current_state");
ALTER TABLE "manuscripts" ADD CONSTRAINT "manuscripts_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manuscripts" ADD CONSTRAINT "manuscripts_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manuscripts" ADD CONSTRAINT "manuscripts_referred_by_reviewer_id_fkey"
  FOREIGN KEY ("referred_by_reviewer_id") REFERENCES "reviewer_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "manuscript_integrity_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID NOT NULL,
  "revision_no" INTEGER NOT NULL,
  "status" "audit_run_status" NOT NULL DEFAULT 'QUEUED',
  "plagiarism_score" DECIMAL(6,5),
  "plagiarism_risk" VARCHAR(20),
  "plagiarism_provider" VARCHAR(80),
  "ai_risk_score" DECIMAL(6,5),
  "ai_risk_band" VARCHAR(20),
  "ai_detector_provider" VARCHAR(80),
  "ai_detector_model_version" VARCHAR(120),
  "citation_validation_score" DECIMAL(6,5),
  "unresolved_citation_count" INTEGER NOT NULL DEFAULT 0,
  "citation_warning_count" INTEGER NOT NULL DEFAULT 0,
  "requires_human_review" BOOLEAN NOT NULL DEFAULT false,
  "policy_rules_hit" JSONB NOT NULL DEFAULT '[]',
  "evidence_payload" JSONB NOT NULL DEFAULT '{}',
  "author_report_r2_key" TEXT,
  "decision" "manuscript_state",
  "resolved_by" UUID,
  "resolved_reason" TEXT,
  "resolved_at" TIMESTAMPTZ(6),
  "config_revision_id" UUID,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manuscript_integrity_audits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "manuscript_integrity_audits_manuscript_id_revision_no_key"
  ON "manuscript_integrity_audits"("manuscript_id","revision_no");
CREATE INDEX "manuscript_integrity_audits_status_idx" ON "manuscript_integrity_audits"("status");
ALTER TABLE "manuscript_integrity_audits" ADD CONSTRAINT "manuscript_integrity_audits_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "manuscript_citations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID NOT NULL,
  "audit_id" UUID NOT NULL,
  "bibliography_index" INTEGER,
  "raw_reference" TEXT NOT NULL,
  "in_text_contexts" JSONB NOT NULL DEFAULT '[]',
  "normalized_title" TEXT,
  "normalized_authors" JSONB NOT NULL DEFAULT '[]',
  "publication_year" INTEGER,
  "supplied_doi" TEXT,
  "resolved_doi" TEXT,
  "crossref_work_id" TEXT,
  "openalex_work_id" TEXT,
  "resolution_status" "citation_resolution_status" NOT NULL,
  "metadata_match_score" DECIMAL(6,5),
  "semantic_relevance_score" DECIMAL(6,5),
  "citation_context_vector" vector(1536),
  "warning_codes" TEXT[],
  "disposition" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manuscript_citations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "manuscript_citations_audit_id_idx" ON "manuscript_citations"("audit_id");
CREATE INDEX "idx_citation_context_vector" ON "manuscript_citations" USING hnsw ("citation_context_vector" vector_cosine_ops);
ALTER TABLE "manuscript_citations" ADD CONSTRAINT "manuscript_citations_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "manuscript_citations" ADD CONSTRAINT "manuscript_citations_audit_id_fkey"
  FOREIGN KEY ("audit_id") REFERENCES "manuscript_integrity_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "citation_recommendations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID NOT NULL,
  "audit_id" UUID NOT NULL,
  "source" VARCHAR(30) NOT NULL,
  "external_work_id" TEXT,
  "doi" TEXT,
  "title" TEXT NOT NULL,
  "publication_year" INTEGER,
  "relevance_score" DECIMAL(6,5) NOT NULL,
  "graph_proximity_score" DECIMAL(6,5),
  "recommendation_reason" TEXT,
  "rank_position" INTEGER NOT NULL,
  "selected_by_author" BOOLEAN,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "citation_recommendations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_recommendation_has_identifier" CHECK ("doi" IS NOT NULL OR "external_work_id" IS NOT NULL)
);
CREATE INDEX "citation_recommendations_audit_id_idx" ON "citation_recommendations"("audit_id");
ALTER TABLE "citation_recommendations" ADD CONSTRAINT "citation_recommendations_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "citation_recommendations" ADD CONSTRAINT "citation_recommendations_audit_id_fkey"
  FOREIGN KEY ("audit_id") REFERENCES "manuscript_integrity_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payment_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID,
  "gateway_reference" TEXT NOT NULL,
  "payment_type" VARCHAR(20) NOT NULL,
  "amount_naira" DECIMAL(10,2) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "raw_webhook_payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_ledger_payment_type_check" CHECK ("payment_type" IN ('EVALUATION_FEE','APC'))
);
CREATE UNIQUE INDEX "payment_ledger_gateway_reference_key" ON "payment_ledger"("gateway_reference");
-- At most one successful payment per gate per manuscript
CREATE UNIQUE INDEX "uq_payment_gate_success" ON "payment_ledger"("manuscript_id","payment_type") WHERE "status" = 'success';
ALTER TABLE "payment_ledger" ADD CONSTRAINT "payment_ledger_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "referral_payout_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reviewer_id" UUID,
  "manuscript_id" UUID,
  "amount_naira" DECIMAL(10,2) NOT NULL DEFAULT 1000,
  "status" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_payout_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_payout_ledger_status_check" CHECK ("status" IN ('PENDING','CREDITED','WITHDRAWN'))
);
CREATE UNIQUE INDEX "referral_payout_ledger_manuscript_id_key" ON "referral_payout_ledger"("manuscript_id");
ALTER TABLE "referral_payout_ledger" ADD CONSTRAINT "referral_payout_ledger_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "reviewer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_payout_ledger" ADD CONSTRAINT "referral_payout_ledger_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gate2_distribution_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID,
  "payment_ledger_id" UUID,
  "tech_support_naira" DECIMAL(10,2) NOT NULL DEFAULT 3000,
  "designer_naira" DECIMAL(10,2) NOT NULL DEFAULT 1000,
  "journal_account_naira" DECIMAL(10,2) NOT NULL DEFAULT 12000,
  "journal_manager_naira" DECIMAL(10,2) NOT NULL DEFAULT 9500,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate2_distribution_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_gate2_split_totals_25500" CHECK (
    "tech_support_naira" + "designer_naira" + "journal_account_naira" + "journal_manager_naira" = 25500.00
  )
);
CREATE UNIQUE INDEX "gate2_distribution_ledger_payment_ledger_id_key" ON "gate2_distribution_ledger"("payment_ledger_id");
ALTER TABLE "gate2_distribution_ledger" ADD CONSTRAINT "gate2_distribution_ledger_manuscript_id_fkey"
  FOREIGN KEY ("manuscript_id") REFERENCES "manuscripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gate2_distribution_ledger" ADD CONSTRAINT "gate2_distribution_ledger_payment_ledger_id_fkey"
  FOREIGN KEY ("payment_ledger_id") REFERENCES "payment_ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "integrity_config_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "config" JSONB NOT NULL,
  "changed_by" UUID,
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integrity_config_revisions_pkey" PRIMARY KEY ("id")
);

-- Backfill: give every in-flight legacy submission a manuscript row. Legacy fees
-- already paid (vetting_fee / processing_fee) are mapped onto the new state machine.
-- Gate-1 legacy payments pre-date the audit stack, so they enter IN_AUDIT with no
-- audit row; editors can run the audit from the review queue.
INSERT INTO "manuscripts" ("submission_id","title","abstract","author_id","current_state","raw_file_r2_key","doi")
SELECT s."id", a."title", a."abstract", s."submitter_id",
  CASE
    WHEN a."status" = 'published' THEN 'PUBLISHED'::manuscript_state
    WHEN a."status" = 'ready_for_publication' THEN 'READY_FOR_RELEASE'::manuscript_state
    WHEN a."status" = 'processed' THEN 'IN_PRODUCTION'::manuscript_state
    WHEN a."status" = 'accepted' THEN 'ACCEPTED'::manuscript_state
    WHEN a."status" = 'under_review' THEN 'IN_PEER_REVIEW'::manuscript_state
    WHEN a."status" = 'rejected' THEN 'AUDIT_REJECTED'::manuscript_state
    WHEN a."vetting_fee" THEN 'SUBMITTED'::manuscript_state
    ELSE 'DRAFT_PENDING_FEE1'::manuscript_state
  END,
  a."manuscript_file_url", COALESCE(a."crossrefDoi", a."doi")
FROM "submissions" s
JOIN "articles" a ON a."id" = s."article_id"
WHERE s."submitter_id" IS NOT NULL
ON CONFLICT DO NOTHING;
