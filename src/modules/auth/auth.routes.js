import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import {
  registerController,
  loginController,
  logoutController,
  logoutAllController,
  meController,
  forgotPasswordController,
  resetPasswordController,
} from "./auth.controller.js";

const router = Router();

router.post("/register", registerController);
router.post("/login", loginController);
router.post("/logout", authenticate, logoutController);
router.post("/logout-all", authenticate, logoutAllController);
router.get("/me", authenticate, meController);
router.post("/forgot-password", forgotPasswordController);
router.post("/reset-password", resetPasswordController);

export default router;
