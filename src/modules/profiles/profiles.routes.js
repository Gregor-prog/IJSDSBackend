import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, update, listMySetupRequests, createSetupRequest } from "./profiles.controller.js";

const router = Router();

router.use(authenticate);

// Paid (₦5,000) scholarly account setup assistance requests
router.get("/setup-requests/mine", listMySetupRequests);
router.post("/setup-requests", createSetupRequest);

// Editors/admins can list profiles (e.g. to find reviewers)
router.get("/", authorize("editor", "admin"), list);
router.get("/:id", getOne);
router.patch("/:id", update);

export default router;
