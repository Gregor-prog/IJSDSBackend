import { templates } from "../email/email.templates.js";
import {
  listNotifications,
  markRead,
  markAllRead,
  createNotification,
  registerClient,
  unregisterClient,
} from "./notifications.service.js";
import sendEmail from "../email/email.service.js";

export const list = async (req, res, next) => {
  try {
    const data = await listNotifications(req.user.id, {
      unreadOnly: req.query.unread_only,
    });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const markOneRead = async (req, res, next) => {
  try {
    const data = await markRead(req.params.id, req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const markAllAsRead = async (req, res, next) => {
  try {
    await markAllRead(req.user.id);
    return res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (err) {
    next(err);
  }
};

// ── Send (email + in-app) ─────────────────────────────────────────────────────
// POST /api/notifications/send
// Sends a templated email via Resend, logs it to email_notifications,
// and optionally creates an in-app notification pushed over SSE.
//
// Body: { template, to, recipientId?, inApp?, inAppTitle?, inAppMessage?, inAppType?, ...templateVars }
export const send = async (req, res, next) => {
  try {
    // Accept both camelCase and the frontend's snake_case, and template vars either at the top
    // level or nested under `data` (the frontend nests them).
    const b = req.body ?? {};
    const {
      template,
      to,
      recipientId = b.recipient_id,
      inApp = b.in_app ?? false,
      inAppTitle = b.in_app_title,
      inAppMessage = b.in_app_message,
      inAppType = b.in_app_type ?? "info",
      submissionId = b.submission_id,
      data: nested = {},
      // drop transport fields so they don't leak into template vars
      recipient_id, in_app, in_app_title, in_app_message, in_app_type, submission_id, role,
      ...topLevelVars
    } = b;
    const templateVars = { ...topLevelVars, ...(nested && typeof nested === "object" ? nested : {}) };

    if (!template || !to) {
      return res.status(400).json({
        success: false,
        message: "template and to are required",
      });
    }
    if (!templates[template]) {
      return res.status(400).json({ success: false, message: `Unknown email template "${template}"` });
    }

    await sendEmail(template, { ...templateVars, to, recipientId, submissionId });

    // Optionally push a simultaneous in-app notification
    if (inApp && recipientId) {
      await createNotification({
        user_id: recipientId,
        title: inAppTitle ?? template,
        message: inAppMessage ?? `You have a new notification regarding: ${template}`,
        type: inAppType,
      });
    }

    return res.status(200).json({ success: true, message: "Notification sent" });
  } catch (err) {
    next(err);
  }
};

// ── Server-Sent Events stream ─────────────────────────────────────────────────
// The frontend connects once and receives live notification pushes.
// Replace Supabase realtime subscription: supabase.channel('user-notifications')
//
// Frontend usage:
//   const es = new EventSource('/api/notifications/stream', {
//     headers: { Authorization: `Bearer ${token}` }
//   })
//   es.onmessage = (e) => console.log(JSON.parse(e.data))
export const stream = (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const userId = req.user.id;

  // Send an initial heartbeat so the client knows the connection is live
  res.write(`: connected\n\n`);

  registerClient(userId, res);

  // Heartbeat every 30s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unregisterClient(userId, res);
  });
};
