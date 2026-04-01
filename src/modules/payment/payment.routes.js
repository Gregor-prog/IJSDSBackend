import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import paystackController from "./payment.controller.js";

const router = Router();

router.post("/verify-payment", authenticate, paystackController);

export default router;
