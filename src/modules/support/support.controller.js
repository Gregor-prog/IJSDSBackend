import { submitSupportTicket } from "./support.service.js";

export const create = async (req, res, next) => {
  try {
    const { name, email, subject, category, message } = req.body;

    // Validate required fields
    const missing = [];
    if (!name) missing.push("name");
    if (!email) missing.push("email");
    if (!subject) missing.push("subject");
    if (!message) missing.push("message");

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    const result = await submitSupportTicket({ name, email, subject, category, message });

    return res.status(201).json({
      success: true,
      message: "Support ticket submitted successfully. A confirmation has been sent to your email.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
