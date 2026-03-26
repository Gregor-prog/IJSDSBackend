import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, create } from "./rejection-messages.controller.js";

const router = Router();

router.use(authenticate, authorize("editor", "admin"));

router.get("/:submissionId", list);
router.post("/", create);

export default router;
