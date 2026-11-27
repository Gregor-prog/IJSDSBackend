import express, { Router } from "express";
import authenticate, { authorize } from "../../middleware/auth.js";
import validateUuid from "../../middleware/validateUuid.js";
import { upload, uploadToSupabase } from "../../middleware/fileInterceptor.middleware.js";
import * as c from "./ijsds2.controller.js";

// Webhook needs the RAW body for HMAC verification, so it is mounted separately in
// app.js BEFORE express.json().
export const webhookRouter = Router();
webhookRouter.post("/", express.raw({ type: "*/*", limit: "1mb" }), c.paystackWebhook);

const router = Router();

// Public
router.get("/cycle", c.cycle);

router.use(authenticate);

// Authors
router.post("/referrals/validate", c.validateReferral);
router.post("/payments/verify", c.verifyPayment);
router.get("/manuscripts/by-submission/:submissionId", validateUuid("submissionId"), c.manuscriptBySubmission);
router.get("/manuscripts/:id/audit-report", validateUuid("id"), c.latestAuditReport);
router.get("/audits/:auditId/report", validateUuid("auditId"), c.auditReport);
router.post("/manuscripts/:id/revision", validateUuid("id"), upload.single("file"), uploadToSupabase, c.uploadRevision);
router.post("/manuscripts/:id/author-revision", validateUuid("id"), upload.single("file"), uploadToSupabase, c.authorRevision);
router.patch("/recommendations/:id", validateUuid("id"), c.selectRecommendation);
router.patch("/citations/:id/disposition", validateUuid("id"), c.dispositionCitation);

// Reviewers
router.get("/reviewer/me", authorize("reviewer"), c.myReviewerProfile);
router.patch("/reviewer/me", authorize("reviewer"), c.updateMyReviewerProfile);
router.get("/reviewer/referrals", authorize("reviewer"), c.myReferrals);
router.get("/reviewer/withdrawals", authorize("reviewer"), c.myWithdrawals);
router.post("/reviewer/withdrawals", authorize("reviewer"), c.withdrawalRequest);

// Editorial staff
router.get("/audits/review-queue", authorize("editor", "admin"), c.reviewQueue);
router.post("/audits/:auditId/resolve", authorize("editor", "admin"), validateUuid("auditId"), c.resolve);
router.post("/audits/:auditId/requeue", authorize("editor", "admin"), validateUuid("auditId"), c.requeue);
router.get("/manuscripts/:id/reviewers/match", authorize("editor", "admin"), c.match);
router.post("/manuscripts/:id/reviewers/assign", authorize("editor", "admin"), c.assign);
router.get("/batch/status", authorize("editor", "admin"), c.batchStatus);
router.post("/articles/:id/release-now", authorize("editor", "admin"), validateUuid("id"), c.releaseNow);

// Admin only
router.get("/withdrawals", authorize("admin"), c.allWithdrawals);
router.post("/withdrawals/:id/process", authorize("admin"), validateUuid("id"), c.withdrawalProcess);
router.post("/batch/execute", authorize("admin"), c.batchExecute);
router.get("/config/integrity", authorize("editor", "admin"), c.getConfig);
router.put("/config/integrity", authorize("admin"), c.putConfig);
router.get("/config/ai-routing", authorize("editor", "admin"), c.getAiRouting);
router.put("/config/ai-routing", authorize("admin"), c.putAiRouting);

// Stage 6: AI-Assisted Final Manuscript Edit, Template Registry, Deterministic Render & Proof QA
router.get("/templates", authorize("editor", "admin"), c.listPublicationTemplates);
router.get("/production/:articleId/copyedit", authorize("editor", "admin"), validateUuid("articleId"), c.latestCopyedit);
router.post("/production/:articleId/copyedit/run", authorize("editor", "admin"), validateUuid("articleId"), c.runCopyedit);
router.patch(
  "/production/:articleId/copyedit/proposals/:proposalId",
  authorize("editor", "admin"),
  validateUuid("articleId"),
  validateUuid("proposalId"),
  c.decideProposal,
);
router.post("/production/:articleId/copyedit/lock", authorize("editor", "admin"), validateUuid("articleId"), c.lockCopyedit);
router.get("/production/:articleId/runs/latest", authorize("editor", "admin"), validateUuid("articleId"), c.latestProductionRun);
router.post("/production/:articleId/runs", authorize("editor", "admin"), validateUuid("articleId"), c.startProduction);
router.post("/production/runs/:runId/approvals", authorize("editor", "admin"), validateUuid("runId"), c.approveProduction);

export default router;
