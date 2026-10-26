CREATE TABLE "reviewer_applications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profile_id" UUID NOT NULL,
  "full_name" TEXT NOT NULL,
  "institutional_email" TEXT NOT NULL,
  "orcid_id" VARCHAR(19) NOT NULL,
  "researchgate_url" TEXT NOT NULL,
  "google_scholar_url" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "decided_by" UUID,
  "decision_reason" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reviewer_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviewer_applications_status_check" CHECK ("status" IN ('PENDING','APPROVED','DECLINED'))
);
CREATE INDEX "reviewer_applications_status_idx" ON "reviewer_applications"("status");
CREATE INDEX "reviewer_applications_profile_id_idx" ON "reviewer_applications"("profile_id");
-- At most one application under review per person
CREATE UNIQUE INDEX "reviewer_applications_one_pending" ON "reviewer_applications"("profile_id") WHERE "status" = 'PENDING';
ALTER TABLE "reviewer_applications" ADD CONSTRAINT "reviewer_applications_profile_id_fkey"
  FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
