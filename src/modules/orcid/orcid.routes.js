import { Router } from "express";
import orcidCallback from "./orcid.controller.js";

const router = Router();

router.get("/orcid", orcidCallback);

export default router;
