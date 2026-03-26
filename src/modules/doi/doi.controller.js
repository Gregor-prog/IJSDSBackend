import { generateDoi } from "./doi.service.js";

export const generate = async (req, res, next) => {
  try {
    const { submissionId, existingDoi } = req.body;

    if (!submissionId) {
      return res.status(400).json({ success: false, message: "submissionId is required" });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(submissionId)) {
      return res.status(400).json({ success: false, message: "submissionId must be a valid UUID" });
    }

    const data = await generateDoi({ submissionId, existingDoi });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
