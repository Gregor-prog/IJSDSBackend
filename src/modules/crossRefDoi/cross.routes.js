import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { register, reDeposit, jobStatus, previewXml } from "./cross.controller.js";

const router = Router();

router.use(authenticate);
router.use(authorize("editor", "admin"));

router.post("/register", register);
router.post("/redeposit", reDeposit);
router.get("/status/:jobId", jobStatus);
router.get("/preview/:articleId", previewXml);

export default router;
