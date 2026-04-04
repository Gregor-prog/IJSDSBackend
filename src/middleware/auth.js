import jwt from "jsonwebtoken";

/**
 * Verifies the Bearer JWT on every protected route.
 * Attaches the decoded payload to req.user on success.
 *
 * Usage:
 *   router.get("/protected", authenticate, controller)
 *
 * Roles (stored in token as req.user.role):
 *   "author" | "reviewer" | "editor" | "admin"
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role, iat, exp }
    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(401).json({ success: false, message });
  }
};

/**
 * Role guard — use AFTER authenticate.
 * Pass one or more allowed roles.
 *
 * Usage:
 *   router.patch("/approve", authenticate, authorize("editor", "admin"), controller)
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // High-priority permission checks
    const hasAdminAccess = user.is_admin || user.role === "admin";
    const hasEditorAccess = user.is_editor || user.role === "editor";
    const hasReviewerAccess = user.is_reviewer || user.role === "reviewer";

    let isAuthorized = false;

    // Check specific role requirements
    if (roles.includes("admin") && hasAdminAccess) isAuthorized = true;
    else if (roles.includes("editor") && (hasEditorAccess || hasAdminAccess))
      isAuthorized = true;
    else if (
      roles.includes("reviewer") &&
      (hasReviewerAccess || hasEditorAccess || hasAdminAccess)
    )
      isAuthorized = true;
    else if (roles.includes(user.role)) isAuthorized = true;

    if (!isAuthorized) {
      console.log(`Access denied for user ${user.id} (role: ${user.role})`);
      return res
        .status(403)
        .json({ success: false, message: "Insufficient permissions" });
    }
    next();
  };
};

export default authenticate;
