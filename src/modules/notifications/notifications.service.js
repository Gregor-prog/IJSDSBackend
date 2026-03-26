import prisma from "../../config/prisma.js";

// ── In-process SSE client registry ───────────────────────────────────────────
// Maps userId → Set of SSE response objects
// When a notification is created, push it to all active connections for that user.
const clients = new Map();

export const registerClient = (userId, res) => {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
};

export const unregisterClient = (userId, res) => {
  clients.get(userId)?.delete(res);
  if (clients.get(userId)?.size === 0) clients.delete(userId);
};

const pushToUser = (userId, notification) => {
  clients.get(userId)?.forEach((res) => {
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  });
};

// ── CRUD ──────────────────────────────────────────────────────────────────────

export const listNotifications = async (userId, { unreadOnly }) => {
  const where = { user_id: userId };
  if (unreadOnly === "true") where.read = false;

  return prisma.notification.findMany({
    where,
    orderBy: { created_at: "desc" },
    take: 50,
  });
};

export const markRead = async (id, userId) => {
  const notification = await prisma.notification.findUnique({ where: { id } });

  if (!notification) {
    const err = new Error("Notification not found");
    err.status = 404;
    throw err;
  }

  if (notification.user_id !== userId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  return prisma.notification.update({
    where: { id },
    data: { read: true },
  });
};

export const markAllRead = async (userId) => {
  return prisma.notification.updateMany({
    where: { user_id: userId, read: false },
    data: { read: true },
  });
};

// Called by other services (email module, workflow, etc.) to create a notification
// and immediately push it to any live SSE connections for that user.
export const createNotification = async ({ user_id, title, message, type = "info" }) => {
  const notification = await prisma.notification.create({
    data: { user_id, title, message, type },
  });

  pushToUser(user_id, notification);

  return notification;
};
