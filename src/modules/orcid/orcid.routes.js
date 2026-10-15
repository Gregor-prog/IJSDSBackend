import { Router } from "express";
import orcidCallback, { orcidStart } from "./orcid.controller.js";

const router = Router();

router.get("/orcid/start", orcidStart);
router.get("/orcid", orcidCallback);

export default router;
