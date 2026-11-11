import { Router } from "express";
import prisma from "../../config/prisma.js";
import express from "express";
import { requireAgentKey, rateLimit, makeCounter } from "./agent-blog.guard.js";
import { makeMcpHandler } from "./agent-blog.mcp.js";
import { makeAgentBlogService } from "./agent-blog.service.js";
import { buildOpenApiSpec } from "./agent-blog.openapi.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 60 * 60 * 1000;

const handle = (fn, code = 200) => async (req, res, next) => {
  try {
    res.status(code).json(await fn(req));
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const ownId = (req) => {
  if (!UUID_RE.test(req.params.id)) throw Object.assign(new Error("Post not found"), { status: 404 });
  return req.params.id;
};

/**
 * The only API the AI blog writer can use: create, list, read and update its own blog posts,
 * as REST (x-agent-key header) or as an MCP server for a ChatGPT plugin (key in the URL).
 * The OpenAPI document is public (it holds no secrets).
 */
export function makeAgentBlogRouter(service = makeAgentBlogService(prisma), { writesPerHour = 30, readsPerHour = 300 } = {}) {
  const router = Router();
  // Mounted before the app's JSON parser and CORS: these are server-to-server calls.
  router.use(express.json({ limit: "1mb" }));
  router.get("/openapi.json", (req, res) => res.json(buildOpenApiSpec(process.env.PUBLIC_API_URL || `https://${req.get("host")}`)));

  const posts = Router();
  posts.use(requireAgentKey);
  const reads = rateLimit({ limit: readsPerHour, windowMs: HOUR });
  const writes = rateLimit({ limit: writesPerHour, windowMs: HOUR });

  posts.get("/", reads, handle((req) => service.list({ limit: Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50) })));
  posts.get("/:id", reads, handle((req) => service.get(ownId(req))));
  posts.post("/", writes, handle((req) => service.create(req.body ?? {}), 201));
  posts.patch("/:id", writes, handle((req) => service.update(ownId(req), req.body ?? {})));

  router.use("/blog/posts", posts);

  // ChatGPT plugin (MCP), with its own hourly budgets of the same size.
  const mcp = makeMcpHandler(service, {
    read: makeCounter({ limit: readsPerHour, windowMs: HOUR }),
    write: makeCounter({ limit: writesPerHour, windowMs: HOUR }),
  });
  router.all("/mcp/:key", mcp);
  return router;
}

export default makeAgentBlogRouter();
