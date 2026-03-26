import {
  register,
  login,
  getMe,
  requestPasswordReset,
  resetPassword,
  blockToken,
} from "./auth.service.js";

export const registerController = async (req, res, next) => {
  try {
    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "full_name, email and password are required" });
    }

    const result = await register({ full_name, email, password });
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

export const loginController = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "email and password are required" });
    }

    const result = await login({ email, password });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

export const logoutController = (req, res) => {
  // The raw token is attached by the auth middleware
  const token = req.headers.authorization?.split(" ")[1];
  if (token) blockToken(token);

  return res.status(200).json({ success: true, message: "Logged out successfully" });
};

export const meController = async (req, res, next) => {
  try {
    const profile = await getMe(req.user.id);
    return res.status(200).json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
};

export const forgotPasswordController = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "email is required" });
    }

    await requestPasswordReset(email);
    // Always return 200 to avoid leaking whether the email exists
    return res.status(200).json({
      success: true,
      message: "If that email is registered, a reset link has been sent",
    });
  } catch (err) {
    next(err);
  }
};

export const resetPasswordController = async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res
        .status(400)
        .json({ success: false, message: "token and password are required" });
    }

    await resetPassword(token, password);
    return res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    next(err);
  }
};
