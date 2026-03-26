import {
  saveFileVersion,
  listFileVersions,
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

export const listVersions = async (req, res, next) => {
  try {
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
