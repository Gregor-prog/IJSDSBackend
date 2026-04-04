import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { StorageService } from "../services/storage.service.js";

const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

// multer parses the file into memory first
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and DOC/DOCX files are allowed"), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// actual upload to Supabase
const uploadToSupabase = async (req, res, next) => {
  try {
    if (!req.file) return next(); // no file, skip

    const nameParts = req.file.originalname.split(".");
    const ext = nameParts.pop();
    const baseName = nameParts.join(".").replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_");
    const fileName = `${baseName}-${Date.now()}.${ext}`;
    
    const folder = req.file.mimetype === "application/pdf" ? "pdfs" : "docs";
    const path = `${folder}/${fileName}`;

    await StorageService.upload(path, req.file.buffer, req.file.mimetype);

    // attach URL to request for the next handler
    req.manuscript_file_url = StorageService.getPublicUrl(path);

    next();
  } catch (err) {
    next(err);
  }
};

export { upload, uploadToSupabase };
