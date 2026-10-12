CREATE TABLE "referral_withdrawals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reviewer_id" UUID NOT NULL,
  "amount_naira" DECIMAL(10,2) NOT NULL,
  "bank_name" TEXT NOT NULL,
  "account_number" TEXT NOT NULL,
  "account_name" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
  "processed_by" UUID,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "referral_withdrawals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_withdrawals_status_check" CHECK ("status" IN ('REQUESTED','PAID','REJECTED')),
  CONSTRAINT "referral_withdrawals_amount_check" CHECK ("amount_naira" > 0)
);
CREATE INDEX "referral_withdrawals_status_idx" ON "referral_withdrawals"("status");
ALTER TABLE "referral_withdrawals" ADD CONSTRAINT "referral_withdrawals_reviewer_id_fkey"
  FOREIGN KEY ("reviewer_id") REFERENCES "reviewer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
