import { generateDoi } from "./doi.service.js";

export const generate = async (req, res, next) => {
  try {
    const { article_id, existingDoi } = req.body;

    if (!article_id) {
      return res.status(400).json({ success: false, message: "article_id is required" });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(article_id)) {
      return res.status(400).json({ success: false, message: "article_id must be a valid UUID" });
    }

    const data = await generateDoi({ articleId: article_id, existingDoi: existingDoi || null });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
