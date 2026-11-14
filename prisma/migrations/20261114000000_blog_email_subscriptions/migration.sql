ALTER TABLE "profiles" ADD COLUMN "blog_emails" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "blog_posts" ADD COLUMN "subscribers_notified_at" TIMESTAMPTZ(6);
-- Posts already live were announced (or not) before this existed; never email them now.
UPDATE "blog_posts" SET "subscribers_notified_at" = now() WHERE "status" = 'published';

CREATE TABLE "blog_subscribers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "unsubscribed_at" TIMESTAMPTZ(6),
    CONSTRAINT "blog_subscribers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "blog_subscribers_email_key" ON "blog_subscribers"("email");
CREATE INDEX "blog_subscribers_status_idx" ON "blog_subscribers"("status");
