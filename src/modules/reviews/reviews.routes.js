import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import upload from "../../config/upload.js";
import { list, getOne, invite, update, uploadFile, removeFile } from "./reviews.controller.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", authorize("editor", "admin"), invite);
router.patch("/:id", update);
router.post("/:id/file", upload.single("file"), uploadFile);
router.delete("/:id/file", removeFile);

export default router;
