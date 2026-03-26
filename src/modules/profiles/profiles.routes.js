import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, update } from "./profiles.controller.js";

const router = Router();

router.use(authenticate);

// Editors/admins can list profiles (e.g. to find reviewers)
router.get("/", authorize("editor", "admin"), list);
router.get("/:id", getOne);
router.patch("/:id", update);

export default router;
