ALTER TABLE "blog_posts" ADD COLUMN "created_by_agent" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "blog_posts_created_by_agent_idx" ON "blog_posts" ("created_by_agent") WHERE "created_by_agent";
