import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

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

// actual upload to R2
const uploadToR2 = async (req, res, next) => {
  try {
    if (!req.file) return next(); // no file, skip

    const ext = req.file.originalname.split(".").pop();
    const fileName = `${uuidv4()}.${ext}`;
    const folder = req.file.mimetype === "application/pdf" ? "pdfs" : "docs";
    const key = `${folder}/${fileName}`;

    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }),
    );

    // attach URL to request for the next handler
    req.manuscript_file_url = `${process.env.R2_PUBLIC_URL}/${key}`;

    next();
  } catch (err) {
    next(err);
  }
};

export { upload, uploadToR2 };
