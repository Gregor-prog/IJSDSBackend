import { listRevisionRequests, createRevisionRequest } from "./revision-requests.service.js";

export const list = async (req, res, next) => {
  try {
    const data = await listRevisionRequests(req.params.submissionId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const data = await createRevisionRequest(req.body, req.user.id);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
