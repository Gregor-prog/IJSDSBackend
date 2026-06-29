import { Router } from "express";
import { renderArticle, renderArticlesList } from "./scholar.controller.js";

const router = Router();

const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

// SSR pages for Google Scholar and users
router.get("/", renderArticlesList);
router.get(`/:id(${uuidPattern})`, renderArticle);

export default router;
