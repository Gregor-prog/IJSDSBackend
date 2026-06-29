// Load .env only in local development — Azure injects env vars directly
import "dotenv/config";
if (process.env.NODE_ENV !== "production") {
  const { config } = await import("dotenv");
  config();
}
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

// BigInt can't be serialized by JSON.stringify — convert to Number (file sizes are well within safe range)
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function () {
  return Number(this);
};

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
import crossRefRoutes from "./src/modules/crossRefDoi/cross.routes.js";
import doajRoutes from "./src/modules/doaj/doaj.routes.js";
import oaiRoutes from "./src/modules/oai/oai.routes.js";
import supportRoutes from "./src/modules/support/support.routes.js";
import scholarRoutes from "./src/modules/scholar/scholar.routes.js";
import { serveSitemap, serveRobotsTxt, serveRssFeed } from "./src/modules/scholar/sitemap.controller.js";
import errorHandler from "./src/middleware/errorHandler.js";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── EJS View Engine (for Server-Side Rendered pages) ──────────────────────────
app.set("views", path.join(__dirname, "src", "views"));
app.set("view engine", "ejs");

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
      // Serve PDFs inline so Google Scholar's crawler can read them
      // Only force download for Word documents
      if (path.endsWith(".pdf")) {
        res.set("Content-Disposition", "inline");
      } else if (path.endsWith(".doc") || path.endsWith(".docx")) {
        res.set("Content-Disposition", "attachment");
      }
    },
  }),
);

// ── SSR Routes (Google Scholar / Crawlers) ────────────────────────────────────
// These must come BEFORE API routes so /papers/:id serves HTML, not JSON
app.get("/sitemap.xml", serveSitemap);
app.get("/robots.txt", serveRobotsTxt);
app.get("/feed/latest-articles.xml", serveRssFeed);
app.use("/papers", scholarRoutes);

// ── API Routes ────────────────────────────────────────────────────────────────
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
app.use("/api/crossref", crossRefRoutes);
app.use("/api/doaj", doajRoutes);
app.use("/api/oai", oaiRoutes);
app.use("/api/support", supportRoutes);

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

export default app;
