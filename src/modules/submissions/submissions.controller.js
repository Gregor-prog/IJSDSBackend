import {
  listSubmissions,
  getSubmission,
  createSubmission,
  updateSubmission,
} from "./submissions.service.js";

export const list = async (req, res, next) => {
  try {
    const { status, submission_type } = req.query;
    const data = await listSubmissions({
      userId: req.user.id,
      role: req.user.role,
      status,
      submissionType: submission_type,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await getSubmission(req.params.id, {
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const required = ["title", "abstract", "authors", "corresponding_author_email"];
    const missing = required.filter((f) => !req.body[f]);
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    const data = await createSubmission(req.body, req.user.id);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updateSubmission(req.params.id, req.body, {
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
