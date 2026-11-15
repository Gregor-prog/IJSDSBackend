import express, { Router } from "express";
import prisma from "../../config/prisma.js";
import { keyMatchesEnv, requireKeyFrom, rateLimit, makeCounter } from "../agent-blog/agent-blog.guard.js";
import { makeAuthorDirectory } from "./agent-authors.service.js";

const HOUR = 60 * 60 * 1000;
const KEY_ENV = "AGENT_AUTHORS_KEY";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "list_ijsds_authors",
    title: "List IJSDS authors",
    description:
      "Read-only. People who have submitted to IJSDS or are named as authors on a submission, newest first, with paper counts. Use it to leave existing authors out of outreach. email_opt_out true means they asked not to be emailed: never contact them.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 100, description: "Filter by name, email or affiliation." },
        since: { type: "string", description: "ISO date: only authors whose latest submission is on or after it." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    run: (dir, a) => dir.list(a),
  },
  {
    name: "check_ijsds_authors",
    title: "Check emails against IJSDS authors",
    description: "Read-only. For each email, says whether the person is already an IJSDS author and whether they opted out of email. Run this on an outreach list before contacting anyone.",
    inputSchema: {
      type: "object",
      required: ["emails"],
      properties: { emails: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 254 } } },
    },
    run: (dir, a) => dir.check(a.emails),
  },
];
const LISTED = TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

const handle = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/**
 * Read-only author directory for the outreach assistant, on its own key (AGENT_AUTHORS_KEY),
 * separate from the blog key. REST with the x-agent-key header, or MCP for a ChatGPT plugin
 * at /api/agent/authors/mcp/<key>. Nothing here writes.
 */
export function makeAgentAuthorsRouter(directory = makeAuthorDirectory(prisma), { readsPerHour = 120 } = {}) {
  const router = Router();
  router.use(express.json({ limit: "256kb" }));

  // MCP first, so its URL key is checked instead of the header guard.
  const take = makeCounter({ limit: readsPerHour, windowMs: HOUR });
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const text = (data, isError = false) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], ...(isError ? {} : { structuredContent: data }), isError });

  const handleMessage = async (msg) => {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    if (msg.id === undefined || msg.id === null) return null; // notifications
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize": {
        const v = msg.params?.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_VERSIONS.includes(v) ? v : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ijsds-authors", title: "IJSDS Authors (read-only)", version: "1.0.0" },
          instructions: "Read-only list of IJSDS authors, for leaving existing authors out of outreach. Never email anyone with email_opt_out true. Do not paste the list into public places.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: LISTED });
      case "tools/call": {
        const tool = byName.get(msg.params?.name);
        if (!tool) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } };
        if (!take()) return ok(text("Rate limit reached for this hour. Try again later.", true));
        try {
          const args = msg.params.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
          return ok(text(await tool.run(directory, args)));
        } catch (err) {
          if (err.status && err.status < 500) return ok(text(err.message, true));
          console.error("[agent-authors] tool failed:", tool.name, err.message);
          return ok(text("The IJSDS server hit an error. Try again shortly.", true));
        }
      }
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  router.all("/mcp/:key", async (req, res, next) => {
    try {
      const ok = keyMatchesEnv(KEY_ENV, req.params.key);
      if (ok === null) return res.status(503).json({ error: "Author directory access is not configured" });
      if (!ok) return res.status(404).json({ error: "Not found" });
      if (req.method !== "POST") return res.set("Allow", "POST").status(405).json({ error: "Use POST" });
      if (Array.isArray(req.body)) {
        const replies = (await Promise.all(req.body.map(handleMessage))).filter(Boolean);
        return replies.length ? res.json(replies) : res.status(202).end();
      }
      const reply = await handleMessage(req.body);
      return reply ? res.json(reply) : res.status(202).end();
    } catch (err) {
      next(err);
    }
  });

  const rest = Router();
  rest.use(requireKeyFrom(KEY_ENV, "Author directory"), rateLimit({ limit: readsPerHour, windowMs: HOUR }));
  rest.get("/", handle((req) => directory.list(req.query)));
  rest.post("/check", handle((req) => directory.check(req.body?.emails)));
  router.use(rest);
  return router;
}

export default makeAgentAuthorsRouter();
