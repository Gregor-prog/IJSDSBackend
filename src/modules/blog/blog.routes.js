import { Router } from "express";
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
