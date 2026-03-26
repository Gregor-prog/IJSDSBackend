import { Router } from "express";
import paystackController from "./payment.controller.js";

const router = Router();

router.post("/verify-payment", paystackController);

export default router;
