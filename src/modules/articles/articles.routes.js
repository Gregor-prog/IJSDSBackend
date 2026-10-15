import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize, optionalAuthenticate } from "../../middleware/auth.js";
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

// Public — the public sees published articles only; staff and a paper's own author/reviewers see more
router.get("/", optionalAuthenticate, list);
router.get("/:id", optionalAuthenticate, validateUuid("id"), getOne);

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
