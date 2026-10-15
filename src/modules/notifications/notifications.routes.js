import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { list, markOneRead, markAllAsRead, send, stream } from "./notifications.controller.js";
import { authorize } from "../../middleware/auth.js";

const router = Router();

// EventSource can't send an Authorization header, so the SSE stream alone accepts ?token=.
const tokenFromQuery = (req, res, next) => {
  if (!req.headers.authorization && typeof req.query.token === "string") {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};
router.get("/stream", tokenFromQuery, authenticate, stream);          // SSE

router.use(authenticate);

router.get("/", list);
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markOneRead);
router.post("/send", authorize("editor", "admin"), send);             // Send email + in-app

export default router;
