import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, invite, update } from "./reviews.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", authorize("editor", "admin"), invite);
router.patch("/:id", update);

export default router;
