import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, update, remove, pingOne, pingAll } from "./articles.controller.js";

const router = Router();

// Public — published articles are readable without auth
router.get("/", list);
router.get("/:id", getOne);

// Protected — editors and admins only
router.patch("/:id", authenticate, authorize("editor", "admin"), update);
router.post("/ping-all", authenticate, authorize("editor", "admin"), pingAll);
router.post("/:id/ping", authenticate, authorize("editor", "admin"), pingOne);

// Delete — authenticated; service enforces submitter-owns-pending OR editor/admin
router.delete("/:id", authenticate, remove);

export default router;
