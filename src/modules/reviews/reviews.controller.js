import { listReviews, getReview, inviteReviewer, updateReview } from "./reviews.service.js";

export const list = async (req, res, next) => {
  try {
    const { submission_id, reviewer_id } = req.query;
    const data = await listReviews({
      submissionId: submission_id,
      reviewerId: reviewer_id,
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await getReview(req.params.id, {
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const invite = async (req, res, next) => {
  try {
    const { submission_id, reviewer_id } = req.body;
    if (!submission_id || !reviewer_id) {
      return res.status(400).json({
        success: false,
        message: "submission_id and reviewer_id are required",
      });
    }
    const data = await inviteReviewer(req.body);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updateReview(req.params.id, req.body, {
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
