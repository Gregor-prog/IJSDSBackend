import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { list, getOne, create, update, syncOneToSheets, syncAllToSheets } from "./submissions.controller.js";
import {
  upload,
  uploadToSupabase,
} from "../../middleware/fileInterceptor.middleware.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/:id", getOne);
router.post("/", upload.single("file"), uploadToSupabase, create);
router.patch("/:id", update);
router.post("/sync-all-to-sheets", authorize("editor", "admin"), syncAllToSheets);
router.post("/:id/sync-sheets", authorize("editor", "admin"), syncOneToSheets);

export default router;
