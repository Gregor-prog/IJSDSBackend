-- IJSDS 2.0 v2.4.2-PROD Additive Migration:
-- Multi-provider AI routing revisions, AI task metering ledger,
-- and Stage 6 final-edit, template registry, rendering, QA, and approval ledgers.

CREATE TABLE IF NOT EXISTS "ai_routing_config_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "config" JSONB NOT NULL,
  "changed_by" UUID,
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_routing_config_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ai_task_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "manuscript_id" UUID,
  "article_id" UUID,
  "stage" VARCHAR(20) NOT NULL,
  "task" VARCHAR(64) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "idempotency_key" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "prompt_version" VARCHAR(40) NOT NULL,
  "policy_version" VARCHAR(40) NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_tokens" INTEGER NOT NULL DEFAULT 0,
  "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "latency_ms" INTEGER NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "ai_task_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_task_runs_idempotency_key_key" UNIQUE ("idempotency_key")
);

CREATE INDEX IF NOT EXISTS "ai_task_runs_manuscript_id_stage_created_at_idx"
  ON "ai_task_runs"("manuscript_id", "stage", "created_at");
CREATE INDEX IF NOT EXISTS "ai_task_runs_article_id_stage_created_at_idx"
  ON "ai_task_runs"("article_id", "stage", "created_at");

CREATE TABLE IF NOT EXISTS "publication_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version" VARCHAR(32) NOT NULL,
  "variant" VARCHAR(64) NOT NULL,
  "archive_source_manifest" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "style_manifest" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "style_manifest_sha256" CHAR(64) NOT NULL,
  "golden_page_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "renderer_version" VARCHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "approved_by" UUID,
  "approved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_templates_variant_version_key" UNIQUE ("variant", "version")
);

CREATE INDEX IF NOT EXISTS "publication_templates_status_idx"
  ON "publication_templates"("status");

CREATE TABLE IF NOT EXISTS "copyedit_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "article_id" UUID NOT NULL,
  "manuscript_id" UUID,
  "ai_run_id" UUID,
  "provider" VARCHAR(24) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "prompt_version" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "accepted_content_hash" CHAR(64),
  "approved_copyedit_hash" CHAR(64),
  "canonical_blocks" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "locked_blocks" JSONB,
  "locked_by" UUID,
  "locked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "copyedit_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "copyedit_runs_article_id_created_at_idx"
  ON "copyedit_runs"("article_id", "created_at");

CREATE TABLE IF NOT EXISTS "copyedit_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "copyedit_run_id" UUID NOT NULL,
  "block_id" VARCHAR(64) NOT NULL,
  "section" VARCHAR(80) NOT NULL,
  "category" VARCHAR(40) NOT NULL,
  "severity" VARCHAR(20) NOT NULL,
  "original_quote" TEXT NOT NULL,
  "proposed_text" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "verified_source_doi" TEXT,
  "confidence" DECIMAL(4,3) NOT NULL DEFAULT 0.800,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  CONSTRAINT "copyedit_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "copyedit_proposals_copyedit_run_id_fkey"
    FOREIGN KEY ("copyedit_run_id") REFERENCES "copyedit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "copyedit_proposals_copyedit_run_id_idx"
  ON "copyedit_proposals"("copyedit_run_id");

CREATE TABLE IF NOT EXISTS "production_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "article_id" UUID NOT NULL,
  "manuscript_id" UUID,
  "copyedit_run_id" UUID,
  "template_id" UUID NOT NULL,
  "run_no" INTEGER NOT NULL DEFAULT 1,
  "substate" VARCHAR(32) NOT NULL DEFAULT 'TEMPLATE_PENDING',
  "accepted_content_hash" CHAR(64) NOT NULL,
  "approved_copyedit_hash" CHAR(64) NOT NULL,
  "layout_plan_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "renderer_version" VARCHAR(64) NOT NULL,
  "ai_run_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "total_cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_runs_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "production_runs_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "publication_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "production_runs_copyedit_run_id_fkey"
    FOREIGN KEY ("copyedit_run_id") REFERENCES "copyedit_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "production_runs_article_id_created_at_idx"
  ON "production_runs"("article_id", "created_at");

CREATE TABLE IF NOT EXISTS "publication_artefacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "production_run_id" UUID NOT NULL,
  "type" VARCHAR(24) NOT NULL,
  "object_key" TEXT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "metadata_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "page_count" INTEGER,
  "qa_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_artefacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_artefacts_production_run_id_fkey"
    FOREIGN KEY ("production_run_id") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "publication_artefacts_production_run_id_idx"
  ON "publication_artefacts"("production_run_id");

CREATE TABLE IF NOT EXISTS "production_qa_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "production_run_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "content_preservation" JSONB NOT NULL,
  "visual_findings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "vision_provider" VARCHAR(24),
  "vision_model" VARCHAR(120),
  "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_qa_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_qa_reports_production_run_id_fkey"
    FOREIGN KEY ("production_run_id") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "production_qa_reports_production_run_id_idx"
  ON "production_qa_reports"("production_run_id");

CREATE TABLE IF NOT EXISTS "production_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "production_run_id" UUID NOT NULL,
  "artefact_sha256" CHAR(64) NOT NULL,
  "role" VARCHAR(20) NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" TEXT,
  "decision" VARCHAR(20) NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "production_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_approvals_production_run_id_fkey"
    FOREIGN KEY ("production_run_id") REFERENCES "production_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "production_approvals_production_run_id_idx"
  ON "production_approvals"("production_run_id");
