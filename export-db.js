import * as dotenv from "dotenv";
dotenv.config();

import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();

async function main() {
  const models = [
    ["profile", "profiles"],
    ["passwordResetToken", "password_reset_tokens"],
    ["article", "articles"],
    ["submission", "submissions"],
    ["review", "reviews"],
    ["editorialDecision", "editorial_decisions"],
    ["revisionRequest", "revision_requests"],
    ["rejectionMessage", "rejection_messages"],
    ["discussionThread", "discussion_threads"],
    ["discussionMessage", "discussion_messages"],
    ["message", "messages"],
    ["notification", "notifications"],
    ["emailNotification", "email_notifications"],
    ["fileVersion", "file_versions"],
    ["blogPost", "blog_posts"],
    ["partner", "partners"],
    ["systemSetting", "system_settings"],
    ["workflowAuditLog", "workflow_audit_log"],
  ];

  fs.mkdirSync("./db-export", { recursive: true });

  for (const [modelName, fileName] of models) {
    try {
      const data = await prisma[modelName].findMany();
      fs.writeFileSync(
        `./db-export/${fileName}.json`,
        JSON.stringify(data, null, 2),
      );
      console.log(`✓ ${fileName}: ${data.length} rows`);
    } catch (err) {
      console.error(`✗ ${fileName}: ${err.message}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
