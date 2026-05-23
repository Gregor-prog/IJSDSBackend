import { registerDoi, reDepositDoi, buildDepositXml, buildDoi } from "./cross.service.js";
import prisma from "../../config/prisma.js";

// POST /api/crossref/register  { articleId }
export const register = async (req, res, next) => {
  try {
    const { articleId } = req.body;
    if (!articleId) {
      return res.status(400).json({ success: false, message: "articleId is required" });
    }
    const data = await registerDoi({ articleId });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// POST /api/crossref/redeposit  { articleId }
export const reDeposit = async (req, res, next) => {
  try {
    const { articleId } = req.body;
    if (!articleId) {
      return res.status(400).json({ success: false, message: "articleId is required" });
    }
    const data = await reDepositDoi({ articleId });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// GET /api/crossref/preview/:articleId  — returns the XML without depositing
export const previewXml = async (req, res, next) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.articleId },
    });

    if (!article) {
      return res.status(404).json({ success: false, message: "Article not found" });
    }

    const doi = article.doi ?? buildDoi(article);
    const batchId = `ijsds-preview-${article.id.slice(0, 8)}`;
    const xml = buildDepositXml(article, doi, batchId);

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
};
