import { v4 as uuidv4 } from "uuid";
import mammoth from "mammoth";
import prisma from "../../config/prisma.js";
import { StorageService } from "../../services/storage.service.js";

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

  const nameParts = file.originalname.split(".");
  const ext = nameParts.pop();
  const baseName = nameParts.join(".").replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_");
  const fileName = `${baseName}-${Date.now()}.${ext}`;

  const folder = isSupplementary ? "supplementary" : "manuscripts";
  const path = `articles/${articleId}/${folder}/${fileName}`;

  await StorageService.upload(path, file.buffer, file.mimetype);
  const fileUrl = StorageService.getPublicUrl(path);

  const record = await prisma.fileVersion.create({
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
  return { ...record, file_size: record.file_size != null ? Number(record.file_size) : null };
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

  // Delete the physical file from Supabase
  // Extract path from URL if possible, or we might need to store the path in DB.
  // For now, let's try to extract the relative path from the URL.
  // The URL structure usually is: https://[ref].supabase.co/storage/v1/object/public/[bucket]/[path]
  const bucketName = process.env.SUPABASE_BUCKET_NAME;
  const urlParts = fileVersion.file_url.split(`${bucketName}/`);
  if (urlParts.length > 1) {
    const storagePath = urlParts[1];
    await StorageService.delete(storagePath);
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
