import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, create, update } from "./submissions.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", create);
router.patch("/:id", update);

export default router;
