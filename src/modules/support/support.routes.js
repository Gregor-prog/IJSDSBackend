import { Router } from "express";
import { create } from "./support.controller.js";

const router = Router();

// POST /api/support — no auth required so anyone can submit a ticket
router.post("/", create);

export default router;
