import { listArticles, getArticle, updateArticle, deleteArticle } from "./articles.service.js";

export const list = async (req, res, next) => {
  try {
    const { status, subject_area, volume, issue, doi } = req.query;
    const data = await listArticles({ status, subject_area, volume, issue, doi });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await getArticle(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updateArticle(req.params.id, req.body);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const remove = async (req, res, next) => {
  try {
    await deleteArticle(req.params.id, req.user);
    return res.status(200).json({ success: true, data: null });
  } catch (err) {
    next(err);
  }
};
