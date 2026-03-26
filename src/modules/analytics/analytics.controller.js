import {
  getOverview,
  getReviewerPerformance,
  getEditorialStats,
} from "./analytics.service.js";

export const overview = async (req, res, next) => {
  try {
    const { date_from, date_to } = req.query;
    const data = await getOverview({ dateFrom: date_from, dateTo: date_to });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const reviewerPerformance = async (req, res, next) => {
  try {
    const { date_from, date_to } = req.query;
    const data = await getReviewerPerformance({ dateFrom: date_from, dateTo: date_to });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const editorial = async (req, res, next) => {
  try {
    const { date_from, date_to } = req.query;
    const data = await getEditorialStats({ dateFrom: date_from, dateTo: date_to });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
