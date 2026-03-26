import {
  listPartners,
  getPartner,
  createPartner,
  updatePartner,
  deletePartner,
} from "./partners.service.js";

export const list = async (req, res, next) => {
  try {
    // Admin can pass ?all=true to include inactive partners
    const activeOnly = req.query.all !== "true";
    const data = await listPartners({ activeOnly });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const getOne = async (req, res, next) => {
  try {
    const data = await getPartner(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const data = await createPartner(req.body);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const data = await updatePartner(req.params.id, req.body);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const remove = async (req, res, next) => {
  try {
    await deletePartner(req.params.id);
    return res.status(200).json({ success: true, message: "Partner deleted" });
  } catch (err) {
    next(err);
  }
};
