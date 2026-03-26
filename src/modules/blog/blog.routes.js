import { Router } from "express";
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
} from "./blog.controller.js";

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────
router.get("/", list);
router.get("/slug/:slug", getBySlug);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get("/admin", authenticate, authorize("editor", "admin"), listAdmin);
router.get("/:id", authenticate, authorize("editor", "admin"), getById);
router.post("/", authenticate, authorize("editor", "admin"), create);
router.patch("/:id", authenticate, authorize("editor", "admin"), update);
router.delete("/:id", authenticate, authorize("editor", "admin"), remove);

export default router;
