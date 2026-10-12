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

// Admin only
router.get("/withdrawals", authorize("admin"), c.allWithdrawals);
router.post("/withdrawals/:id/process", authorize("admin"), validateUuid("id"), c.withdrawalProcess);
router.post("/batch/execute", authorize("admin"), c.batchExecute);
router.get("/config/integrity", authorize("editor", "admin"), c.getConfig);
router.put("/config/integrity", authorize("admin"), c.putConfig);

export default router;
