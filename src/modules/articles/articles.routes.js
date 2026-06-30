import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import validateUuid from "../../middleware/validateUuid.js";
import {
  list,
  getOne,
  update,
  remove,
  pingOne,
  pingAll,
} from "./articles.controller.js";

const router = Router();

// Public — published articles are readable without auth
router.get("/", list);
router.get("/:id", validateUuid("id"), getOne);

// Protected — editors and admins only
router.patch(
  "/:id",
  authenticate,
  authorize("editor", "admin"),
  validateUuid("id"),
  update,
);
router.post("/ping-all", authenticate, authorize("editor", "admin"), pingAll);
router.post(
  "/:id/ping",
  authenticate,
  authorize("editor", "admin"),
  validateUuid("id"),
  pingOne,
);

// Delete — authenticated; service enforces submitter-owns-pending OR editor/admin
router.delete("/:id", authenticate, validateUuid("id"), remove);

export default router;
