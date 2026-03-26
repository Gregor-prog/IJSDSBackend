import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { submit, bulk } from "./doaj.controller.js";

const router = Router();

router.use(authenticate, authorize("editor", "admin"));

router.post("/submit", submit);
router.post("/bulk", bulk);

export default router;
