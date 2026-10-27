import express, { Router } from "express";
import { oaiEndpoint } from "./oai.controller.js";

const router = Router();

// Public: OAI-PMH is an open harvesting protocol.
router.get("/", oaiEndpoint);
router.post("/", express.urlencoded({ extended: false }), oaiEndpoint);

export default router;
