import {
  listThreads,
  createThread,
  listMessages,
  createMessage,
} from "./discussions.service.js";

// ── Threads ───────────────────────────────────────────────────────────────────

export const getThreads = async (req, res, next) => {
  try {
    const data = await listThreads(req.params.submissionId, req.user);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const postThread = async (req, res, next) => {
  try {
    const data = await createThread(req.body, req.user);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ── Messages ──────────────────────────────────────────────────────────────────

export const getMessages = async (req, res, next) => {
  try {
    const data = await listMessages(req.params.threadId, req.user);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const postMessage = async (req, res, next) => {
  try {
    const data = await createMessage(
      req.params.threadId,
      req.body.content,
      req.user
    );
    return res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};
