import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import {
  list,
  getOne,
  update,
  remove,
  pingOne,
  pingAll,
} from "./articles.controller.js";

const router = Router();

const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

// Public — published articles are readable without auth
router.get("/", list);
router.get(`/:id(${uuidPattern})`, getOne);

// Protected — editors and admins only
router.patch(`/:id(${uuidPattern})`, authenticate, authorize("editor", "admin"), update);
router.post("/ping-all", authenticate, authorize("editor", "admin"), pingAll);
router.post(`/:id(${uuidPattern})/ping`, authenticate, authorize("editor", "admin"), pingOne);

// Delete — authenticated; service enforces submitter-owns-pending OR editor/admin
router.delete(`/:id(${uuidPattern})`, authenticate, remove);

export default router;
