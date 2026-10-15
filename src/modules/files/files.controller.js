import { canAccessUnpublishedArticle } from "../../middleware/auth.js";
import prisma from "../../config/prisma.js";
import {
  saveFileVersion,
  listFileVersions,
  getLatestVersion,
  deleteFileVersion,
  convertToHtml,
} from "./files.service.js";

export const upload = async (req, res, next) => {
  try {
    // multer has already validated and saved the file to disk at this point
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const { article_id, description, is_supplementary } = req.body;

    if (!article_id) {
      return res.status(400).json({ success: false, message: "article_id is required" });
    }

    const data = await saveFileVersion(
      {
        articleId: article_id,
        file: req.file,
        description,
        isSupplementary: is_supplementary === "true",
      },
      req.user.id
    );

    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// Files of an unpublished article are visible only to staff and its own author/reviewers.
const assertCanSeeFiles = async (articleId, user) => {
  const a = await prisma.article.findUnique({ where: { id: articleId }, select: { status: true } });
  if (!a || (a.status !== "published" && !(await canAccessUnpublishedArticle(articleId, user)))) {
    const err = new Error("No file found");
    err.status = 404;
    throw err;
  }
};

export const latestVersion = async (req, res, next) => {
  try {
    await assertCanSeeFiles(req.params.articleId, req.user);
    const data = await getLatestVersion(req.params.articleId);
    if (!data) return res.status(404).json({ success: false, message: "No file found" });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const listVersions = async (req, res, next) => {
  try {
    await assertCanSeeFiles(req.params.articleId, req.user);
    const includeArchived = req.query.include_archived === "true";
    const data = await listFileVersions(req.params.articleId, { includeArchived });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const remove = async (req, res, next) => {
  try {
    await deleteFileVersion(req.params.id, req.user.id, req.user.role);
    return res.status(200).json({ success: true, message: "File deleted" });
  } catch (err) {
    next(err);
  }
};

export const convert = async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: "url is required" });
    }

    const html = await convertToHtml(url);
    return res.status(200).json({
      success: true,
      message: "HTML successfully fetched",
      data: html,
    });
  } catch (err) {
    next(err);
  }
};
