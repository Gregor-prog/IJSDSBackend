import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import paystackController, {
  reconcilePayments,
} from "./payment.controller.js";

const router = Router();

router.post("/verify-payment", authenticate, paystackController);
router.get("/history", authenticate, reconcilePayments);

export default router;
