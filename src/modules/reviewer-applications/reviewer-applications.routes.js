import { Router } from "express";
import authenticate, { authorize } from "../../middleware/auth.js";
import validateUuid from "../../middleware/validateUuid.js";
import { submit, mine, list, decide } from "./reviewer-applications.controller.js";

const router = Router();
router.use(authenticate);

router.post("/", submit);
router.get("/me", mine);
router.get("/", authorize("admin"), list);
router.post("/:id/decision", authorize("admin"), validateUuid("id"), decide);

export default router;
