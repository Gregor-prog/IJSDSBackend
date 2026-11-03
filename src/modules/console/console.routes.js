import { Router } from "express";
import prisma from "../../config/prisma.js";
import { requireConsoleToken } from "./console.guard.js";
import { makeConsoleService } from "./console.service.js";

const SUBMISSION_STATUSES = new Set(["submitted", "under_review", "revision_requested", "accepted", "rejected"]);

export function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/** Read-only API for the Parakletus admin console. GET only. */
export function makeConsoleRouter(service = makeConsoleService(prisma)) {
  const router = Router();
  router.use(requireConsoleToken);

  router.get("/summary", async (req, res, next) => {
    try {
      res.json(await service.summary());
    } catch (err) {
      next(err);
    }
  });

  router.get("/submissions", async (req, res, next) => {
    try {
      const status = SUBMISSION_STATUSES.has(req.query.status) ? req.query.status : undefined;
      res.json(
        await service.submissions({
          page: clampInt(req.query.page, 1, 1, 10_000),
          limit: clampInt(req.query.limit, 25, 1, 50),
          status,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default makeConsoleRouter();
