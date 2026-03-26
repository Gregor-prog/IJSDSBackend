import path from "path";
import fs from "fs";
import mammoth from "mammoth";
import prisma from "../../config/prisma.js";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "uploads";
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

// ── Upload ────────────────────────────────────────────────────────────────────

export const saveFileVersion = async (
  { articleId, file, description, isSupplementary },
  uploadedBy
) => {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  // Get next version number for this article
  const lastVersion = await prisma.fileVersion.findFirst({
    where: { article_id: articleId, is_supplementary: isSupplementary ?? false },
    orderBy: { version_number: "desc" },
    select: { version_number: true },
  });

  const versionNumber = (lastVersion?.version_number ?? 0) + 1;

  // Archive the previous latest version if this is a main manuscript
  if (!isSupplementary && lastVersion) {
    await prisma.fileVersion.updateMany({
      where: { article_id: articleId, is_supplementary: false, is_archived: false },
      data: { is_archived: true },
    });
  }

  const fileUrl = `${BASE_URL}/uploads/${path.basename(file.path)}`;

  return prisma.fileVersion.create({
    data: {
      article_id: articleId,
      file_url: fileUrl,
      file_name: file.originalname,
      file_type: file.mimetype,
      file_size: file.size,
      version_number: versionNumber,
      uploaded_by: uploadedBy,
      file_description: description ?? null,
      is_supplementary: isSupplementary ?? false,
      is_archived: false,
    },
  });
};

// ── List versions ─────────────────────────────────────────────────────────────

export const listFileVersions = async (articleId, { includeArchived = false } = {}) => {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  const where = { article_id: articleId };
  if (!includeArchived) where.is_archived = false;

  return prisma.fileVersion.findMany({
    where,
    orderBy: [{ is_supplementary: "asc" }, { version_number: "desc" }],
  });
};

// ── Delete ────────────────────────────────────────────────────────────────────

export const deleteFileVersion = async (id, userId, role) => {
  const fileVersion = await prisma.fileVersion.findUnique({ where: { id } });

  if (!fileVersion) {
    const err = new Error("File not found");
    err.status = 404;
    throw err;
  }

  // Only the uploader or an editor/admin can delete
  if (fileVersion.uploaded_by !== userId && !["editor", "admin"].includes(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  // Delete the physical file from disk
  const filename = path.basename(fileVersion.file_url);
  const filePath = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  await prisma.fileVersion.delete({ where: { id } });
};

// ── Convert .docx → HTML (mammoth) ───────────────────────────────────────────

export const convertToHtml = async (fileUrl) => {
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error("Could not fetch file");

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const { value, messages } = await mammoth.convertToHtml({ buffer });

  if (messages.length > 0) {
    console.warn("Conversion warnings:", messages);
  }

  return value;
};
