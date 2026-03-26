import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { generate } from "./doi.controller.js";

const router = Router();

router.post("/generate", authenticate, authorize("editor", "admin"), generate);

export default router;
