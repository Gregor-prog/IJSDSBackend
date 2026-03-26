import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, create } from "./revision-requests.controller.js";

const router = Router();

router.use(authenticate);

router.get("/:submissionId", list);
router.post("/", authorize("editor", "admin"), create);

export default router;
