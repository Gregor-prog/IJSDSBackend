import { getProfile, updateProfile, listProfiles } from "./profiles.service.js";

export const list = async (req, res, next) => {
  try {
    const { role, is_reviewer, is_editor } = req.query;
    const data = await listProfiles({ role, is_reviewer, is_editor });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await getProfile(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updateProfile(req.params.id, req.body, {
      userId: req.user.id,
      role: req.user.role,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
