import { Router } from "express";
import authenticate from "../../middleware/auth.js";
import { authorize } from "../../middleware/auth.js";
import { dataExport, ajolExport } from "./export.controller.js";

const router = Router();

router.use(authenticate, authorize("editor", "admin"));

router.get("/", dataExport);        // ?dataType=submissions&format=csv&dateFrom=&dateTo=
router.get("/ajol", ajolExport);    // ?format=xml|json

export default router;
