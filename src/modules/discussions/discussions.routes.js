import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import {
  getThreads,
  postThread,
  getMessages,
  postMessage,
} from "./discussions.controller.js";

const router = Router();

router.use(authenticate);

// Threads
router.get("/:submissionId", getThreads);
router.post("/", postThread);

// Messages
router.get("/:threadId/messages", getMessages);
router.post("/:threadId/messages", postMessage);

export default router;
