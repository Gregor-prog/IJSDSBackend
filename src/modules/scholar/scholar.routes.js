import { Router } from "express";
import validateUuid from "../../middleware/validateUuid.js";
import { renderArticle, renderArticlesList } from "./scholar.controller.js";

const router = Router();

// SSR pages for Google Scholar and users
router.get("/", renderArticlesList);
router.get("/:id", validateUuid("id"), renderArticle);

export default router;

