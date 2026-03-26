import { submitArticle, bulkSubmit } from "./doaj.service.js";

export const submit = async (req, res, next) => {
  try {
    const { articleId } = req.body;
    if (!articleId) {
      return res.status(400).json({ success: false, message: "articleId is required" });
    }
    const data = await submitArticle(articleId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const bulk = async (req, res, next) => {
  try {
    const { status } = req.body;
    const data = await bulkSubmit(status);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
