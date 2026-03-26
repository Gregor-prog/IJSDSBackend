import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { list, markOneRead, markAllAsRead, send, stream } from "./notifications.controller.js";
import { authorize } from "../../middleware/auth.js";

const router = Router();

router.use(authenticate);

router.get("/", list);
router.get("/stream", stream);                                        // SSE
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markOneRead);
router.post("/send", authorize("editor", "admin"), send);             // Send email + in-app

export default router;
