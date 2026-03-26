import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, update } from "./articles.controller.js";

const router = Router();

// Public — published articles are readable without auth
router.get("/", list);
router.get("/:id", getOne);

// Protected — editors and admins only
router.patch("/:id", authenticate, authorize("editor", "admin"), update);

export default router;
