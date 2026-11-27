-- Add scholarly verification profile fields and paid (₦5,000) profile setup assistance requests
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "institutional_email" TEXT,
  ADD COLUMN IF NOT EXISTS "google_scholar_url" TEXT,
  ADD COLUMN IF NOT EXISTS "researchgate_url" TEXT;

CREATE TABLE IF NOT EXISTS "profile_setup_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profile_id" UUID NOT NULL,
  "full_name" TEXT NOT NULL,
  "contact_email" TEXT NOT NULL,
  "phone" TEXT,
  "affiliation" TEXT,
  "accounts_needed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notes" TEXT,
  "payment_reference" TEXT NOT NULL,
  "amount_naira" DECIMAL(10, 2) NOT NULL DEFAULT 5000,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PAID',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_setup_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "profile_setup_requests_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "profile_setup_requests_payment_reference_key"
  ON "profile_setup_requests"("payment_reference");
CREATE INDEX IF NOT EXISTS "profile_setup_requests_profile_id_idx"
  ON "profile_setup_requests"("profile_id");
CREATE INDEX IF NOT EXISTS "profile_setup_requests_status_idx"
  ON "profile_setup_requests"("status");
