import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, create, update, remove } from "./partners.controller.js";

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────
router.get("/", list);
router.get("/:id", getOne);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.post("/", authenticate, authorize("admin"), create);
router.patch("/:id", authenticate, authorize("admin"), update);
router.delete("/:id", authenticate, authorize("admin"), remove);

export default router;
