import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import upload from "../../config/upload.js";
import { upload as uploadController, listVersions, latestVersion, remove, convert } from "./files.controller.js";

const router = Router();

// Public — no auth needed to fetch the latest file URL for an article
router.get("/:articleId/latest", latestVersion);

router.use(authenticate);

// Upload a manuscript or supplementary file
router.post("/upload", upload.single("file"), uploadController);

// List all file versions for an article
router.get("/:articleId", listVersions);

// Delete a specific file version
router.delete("/:id", remove);

// Convert a remote .docx file to HTML (replaces legacy /api/getFile)
router.post("/convert", convert);

export default router;
