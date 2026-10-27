ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "tokens_valid_after" TIMESTAMPTZ(6);

CREATE TABLE "revoked_tokens" (
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX "revoked_tokens_expires_at_idx" ON "revoked_tokens"("expires_at");
