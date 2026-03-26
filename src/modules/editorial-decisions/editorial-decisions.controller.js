import { listDecisions, createDecision } from "./editorial-decisions.service.js";

export const list = async (req, res, next) => {
  try {
    const data = await listDecisions(req.params.submissionId);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const data = await createDecision(req.body, req.user.id);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
