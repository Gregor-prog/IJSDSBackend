import "dotenv/config";
import express from "express";
import cors from "cors";

// BigInt can't be serialized by JSON.stringify — convert to Number (file sizes are well within safe range)
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () { return Number(this); };

import authRoutes from "./src/modules/auth/auth.routes.js";
import orcidRoutes from "./src/modules/orcid/orcid.routes.js";
import paymentRoutes from "./src/modules/payment/payment.routes.js";
import filesRoutes from "./src/modules/files/files.routes.js";
import submissionsRoutes from "./src/modules/submissions/submissions.routes.js";
import articlesRoutes from "./src/modules/articles/articles.routes.js";
import profilesRoutes from "./src/modules/profiles/profiles.routes.js";
import reviewsRoutes from "./src/modules/reviews/reviews.routes.js";
import editorialDecisionsRoutes from "./src/modules/editorial-decisions/editorial-decisions.routes.js";
import revisionRequestsRoutes from "./src/modules/revision-requests/revision-requests.routes.js";
import rejectionMessagesRoutes from "./src/modules/rejection-messages/rejection-messages.routes.js";
import discussionsRoutes from "./src/modules/discussions/discussions.routes.js";
import notificationsRoutes from "./src/modules/notifications/notifications.routes.js";
import blogRoutes from "./src/modules/blog/blog.routes.js";
import partnersRoutes from "./src/modules/partners/partners.routes.js";
import doiRoutes from "./src/modules/doi/doi.routes.js";
import doajRoutes from "./src/modules/doaj/doaj.routes.js";
import oaiRoutes from "./src/modules/oai/oai.routes.js";
import exportRoutes from "./src/modules/export/export.routes.js";
import analyticsRoutes from "./src/modules/analytics/analytics.routes.js";
import supportRoutes from "./src/modules/support/support.routes.js";
import errorHandler from "./src/middleware/errorHandler.js";

const app = express();

// ── Request parsing ────────────────────────────────────────────────────────────
app.use(express.json());

// ── CORS ───────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "https://ijsds.org",
  "https://www.ijsds.org",
  "http://localhost:8080",
  "http://localhost:8081",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS policy"));
      }
    },
  }),
);

// ── Static file serving ───────────────────────────────────────────────────────
app.use(
  "/uploads",
  express.static(process.env.UPLOAD_DIR ?? "uploads", {
    setHeaders: (res, path) => {
      // Allow unrestricted cross-origin requests for static files
      res.set("Access-Control-Allow-Origin", "*");
      // Force downloads for PDFs and documents
      if (path.endsWith(".pdf") || path.endsWith(".doc") || path.endsWith(".docx")) {
        res.set("Content-Disposition", "attachment");
      }
    },
  })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/auth", orcidRoutes);
app.use("/api", paymentRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/submissions", submissionsRoutes);
app.use("/api/articles", articlesRoutes);
app.use("/api/profiles", profilesRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/editorial-decisions", editorialDecisionsRoutes);
app.use("/api/revision-requests", revisionRequestsRoutes);
app.use("/api/rejection-messages", rejectionMessagesRoutes);
app.use("/api/discussions", discussionsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/partners", partnersRoutes);
app.use("/api/doi", doiRoutes);
app.use("/api/doaj", doajRoutes);
app.use("/api/oai", oaiRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/support", supportRoutes);

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

export default app;
