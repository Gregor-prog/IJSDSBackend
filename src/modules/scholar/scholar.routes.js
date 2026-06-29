import { Router } from "express";
import { renderArticle, renderArticlesList } from "./scholar.controller.js";

const router = Router();

// SSR pages for Google Scholar and users
router.get("/", renderArticlesList);
router.get("/:id", renderArticle);

export default router;
