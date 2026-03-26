import { Router } from "express";
import { oaiEndpoint } from "./oai.controller.js";

const router = Router();

// Public — OAI-PMH is a publicly accessible protocol endpoint
router.get("/", oaiEndpoint);

export default router;
