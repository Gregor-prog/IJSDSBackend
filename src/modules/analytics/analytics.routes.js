import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { overview, reviewerPerformance, editorial } from "./analytics.controller.js";

const router = Router();

router.use(authenticate, authorize("editor", "admin"));

router.get("/overview", overview);
router.get("/reviewer-performance", reviewerPerformance);
router.get("/editorial", editorial);

export default router;
