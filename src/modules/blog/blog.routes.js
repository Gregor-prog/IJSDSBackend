import express, { Router } from "express";
import multer from "multer";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import {
  list,
  getBySlug,
  listAdmin,
  getById,
  create,
  update,
  remove,
  uploadFeaturedImage,
} from "./blog.controller.js";
import { subscribe, confirmSubscription, unsubscribe } from "./blog.subscriptions.js";

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────
router.get("/", list);
router.get("/slug/:slug", getBySlug);

// ── Email subscriptions (public; declared before "/:id") ────────────────────────
const SITE_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";
const signupsByIp = new Map(); // ip -> { windowStart, count }; per instance, enough to stop floods
const SIGNUPS_PER_HOUR = 5;

router.post("/subscribe", async (req, res, next) => {
  try {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const slot = signupsByIp.get(ip);
    if (!slot || now - slot.windowStart > 3600_000) signupsByIp.set(ip, { windowStart: now, count: 1 });
    else if (++slot.count > SIGNUPS_PER_HOUR) return res.status(429).json({ success: false, message: "Too many sign-ups from here. Try again later." });
    await subscribe(req.body ?? {});
    res.json({ success: true, message: "Check your inbox to confirm your subscription." });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
});
router.get("/subscribe/confirm", async (req, res, next) => {
  try {
    const ok = await confirmSubscription(req.query.token);
    res.redirect(303, `${SITE_URL}/blog?subscription=${ok ? "confirmed" : "invalid"}`);
  } catch (err) { next(err); }
});
router.get("/unsubscribe", async (req, res, next) => {
  try {
    const ok = await unsubscribe(req.query.token);
    res.redirect(303, `${SITE_URL}/blog?subscription=${ok ? "unsubscribed" : "invalid"}`);
  } catch (err) { next(err); }
});
// One-click unsubscribe (RFC 8058): mail clients POST here from the List-Unsubscribe header.
router.post("/unsubscribe", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    res.status((await unsubscribe(req.query.token)) ? 200 : 400).json({ success: true });
  } catch (err) { next(err); }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
router.post(
  "/image",
  authenticate,
  authorize("editor", "admin"),
  imageUpload.single("image"),
  uploadFeaturedImage,
);
router.get("/admin", authenticate, authorize("editor", "admin"), listAdmin);
router.get("/:id", authenticate, authorize("editor", "admin"), getById);
router.post("/", authenticate, authorize("editor", "admin"), create);
router.patch("/:id", authenticate, authorize("editor", "admin"), update);
router.delete("/:id", authenticate, authorize("editor", "admin"), remove);

export default router;
