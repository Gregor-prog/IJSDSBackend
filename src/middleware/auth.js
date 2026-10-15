import jwt from "jsonwebtoken";
import prisma from "../config/prisma.js";

/**
 * Verifies the Bearer JWT on every protected route.
 * Attaches the decoded payload to req.user on success.
 * Permission flags (is_admin, is_editor, is_reviewer) are refreshed from the
 * database on each request so that role promotions take effect immediately
 * without requiring the user to re-login.
 *
 * Usage:
 *   router.get("/protected", authenticate, controller)
 *
 * Roles (stored in token as req.user.role):
 *   "author" | "reviewer" | "editor" | "admin"
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Refresh permission flags from DB so promotions take effect without re-login
    const profile = await prisma.profile.findUnique({
      where: { id: decoded.id },
      select: { role: true, is_admin: true, is_editor: true, is_reviewer: true },
    });

    req.user = {
      ...decoded,
      ...(profile ?? {}),
    };
    next();
  } catch (err) {
    const message =
      err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return res.status(401).json({ success: false, message });
  }
};

/**
 * Like authenticate, but never rejects: a valid token attaches req.user, a missing or invalid
 * one leaves the request anonymous. For public routes whose response depends on who is asking
 * (e.g. staff and a paper's own author/reviewers may see unpublished work; the public may not).
 */
export const optionalAuthenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    const profile = await prisma.profile.findUnique({
      where: { id: decoded.id },
      select: { role: true, is_admin: true, is_editor: true, is_reviewer: true },
    });
    req.user = { ...decoded, ...(profile ?? {}) };
  } catch {
    // expired/invalid token on a public route: treat as anonymous rather than failing the page
  }
  next();
};

export const isStaffUser = (u) =>
  Boolean(u && (u.is_admin || u.is_editor || u.role === "admin" || u.role === "editor"));

/**
 * May this user see an UNPUBLISHED article? Staff always; otherwise only the submitting author
 * or a reviewer assigned to one of its submissions.
 */
export const canAccessUnpublishedArticle = async (articleId, user) => {
  if (!user) return false;
  if (isStaffUser(user)) return true;
  const hit = await prisma.submission.findFirst({
    where: {
      article_id: articleId,
      OR: [{ submitter_id: user.id }, { reviews: { some: { reviewer_id: user.id } } }],
    },
    select: { id: true },
  });
  return Boolean(hit);
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
