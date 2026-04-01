import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, create, update } from "./submissions.controller.js";
import {
  upload,
  uploadToR2,
} from "../../middleware/fileInterceptor.middleware.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", upload.single("file"), uploadToR2, create);
router.patch("/:id", update);

export default router;
