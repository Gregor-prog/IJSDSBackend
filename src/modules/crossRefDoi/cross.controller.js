import { enqueueCrossRefDeposit, getJobStatus } from "../../lib/queue.js";
import { buildDepositXml, buildDoi } from "./cross.service.js";
import prisma from "../../config/prisma.js";

// POST /api/crossref/register  { articleId }
export const register = async (req, res, next) => {
  try {
    const { articleId } = req.body;
    if (!articleId) {
      return res.status(400).json({ success: false, message: "articleId is required" });
    }

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article) {
      return res.status(404).json({ success: false, message: "Article not found" });
    }
    if (article.crossrefDoi) {
      return res.status(409).json({
        success: false,
        message: `Article already has CrossRef DOI: ${article.crossrefDoi}. Use /redeposit to update metadata.`,
      });
    }

    const data = await enqueueCrossRefDeposit(articleId, "register");
    return res.status(202).json({
      success: true,
      message: "DOI registration queued. Poll /status/:jobId to track progress.",
      data,
    });
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

    const article = await prisma.article.findUnique({ where: { id: articleId } });
    if (!article) {
      return res.status(404).json({ success: false, message: "Article not found" });
    }
    if (!article.crossrefDoi) {
      return res.status(400).json({
        success: false,
        message: "Article has no CrossRef DOI yet. Use /register first.",
      });
    }

    const data = await enqueueCrossRefDeposit(articleId, "redeposit");
    return res.status(202).json({
      success: true,
      message: "Re-deposit queued. Poll /status/:jobId to track progress.",
      data,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/crossref/status/:jobId
export const jobStatus = async (req, res, next) => {
  try {
    const status = await getJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
};

// GET /api/crossref/preview/:articleId  — returns compiled XML without depositing
export const previewXml = async (req, res, next) => {
  try {
    const article = await prisma.article.findUnique({
      where: { id: req.params.articleId },
    });
    if (!article) {
      return res.status(404).json({ success: false, message: "Article not found" });
    }

    const doi = article.crossrefDoi ?? buildDoi(article);
    const batchId = `ijsds-preview-${article.id.slice(0, 8)}`;
    const xml = buildDepositXml(article, doi, batchId);

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
};
