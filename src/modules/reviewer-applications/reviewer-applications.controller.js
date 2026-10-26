import { submitApplication, myApplications, listApplications, decideApplication } from "./reviewer-applications.service.js";

const wrap = (fn, code = 200) => async (req, res, next) => {
  try {
    res.status(code).json({ success: true, data: await fn(req) });
  } catch (e) {
    if (e.fields) return res.status(e.status ?? 400).json({ success: false, message: e.message, fields: e.fields });
    next(e);
  }
};

export const submit = wrap((req) => submitApplication(req.user.id, req.body), 201);
export const mine = wrap((req) => myApplications(req.user.id));
export const list = wrap((req) => listApplications(req.query.status ?? "PENDING"));
export const decide = wrap((req) => decideApplication(req.params.id, req.body ?? {}, req.user));
