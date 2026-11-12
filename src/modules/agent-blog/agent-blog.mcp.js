import crypto from "node:crypto";

/**
 * MCP server (streamable HTTP, JSON responses, stateless) for the ChatGPT plugin. ChatGPT
 * plugins can't send a custom key header, so the key is the last segment of the URL:
 * POST /api/agent/mcp/<AGENT_BLOG_KEY>. Treat that URL as a password.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const keyMatches = (given) => {
  const expected = process.env.AGENT_BLOG_KEY ?? "";
  if (expected.length < 32) return null; // not configured
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};

const POST_FIELDS = {
  title: { type: "string", maxLength: 200 },
  content: {
    type: "string",
    maxLength: 100000,
    description: "The article body as HTML. Allowed: h2, h3, h4, p, br, hr, strong, em, u, s, sub, sup, ul, ol, li, blockquote, a (href), img (https src, alt), figure, figcaption, code, pre, table. Anything else is removed. Do not repeat the title as a heading.",
  },
  excerpt: { type: "string", maxLength: 500, description: "One or two plain-text sentences shown in the blog list." },
  category: { type: "string", maxLength: 60 },
  tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
  featured_image_url: { type: "string", description: "Optional https URL of a cover image." },
};
const ID = { id: { type: "string", description: "The post id (from list_blog_posts or create_blog_post)." } };

export const TOOLS = [
  {
    name: "list_blog_posts",
    title: "List IJSDS blog posts",
    description: "List the blog posts this assistant has created on the IJSDS website, newest first, with their status and public links.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (svc, a) => svc.list({ limit: Math.min(Math.max(Number.parseInt(a.limit, 10) || 20, 1), 50) }),
  },
  {
    name: "get_blog_post",
    title: "Read an IJSDS blog post",
    description: "Get one blog post this assistant created, including its full HTML content.",
    inputSchema: { type: "object", required: ["id"], properties: ID },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (svc, a) => svc.get(a.id),
  },
  {
    name: "create_blog_post",
    title: "Save an IJSDS blog draft",
    description: "Save a new blog post on the IJSDS website as a draft. Drafts are not visible on the site. To put it live, the editor must explicitly ask, then use publish_blog_post. Returns the post with its id.",
    inputSchema: { type: "object", required: ["title", "content"], properties: POST_FIELDS },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (svc, a) => svc.create(a),
  },
  {
    name: "update_blog_post",
    title: "Edit an IJSDS blog post",
    description: "Edit a blog post this assistant created. Send only the fields to change. Edits to a published post show on the website immediately. status \"draft\" takes a published post off the website. The post's link never changes.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { ...ID, ...POST_FIELDS, status: { type: "string", enum: ["draft"], description: "Set to draft to take the post off the website." } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (svc, a) => {
      const { id, ...changes } = a;
      return svc.update(id, changes);
    },
  },
  {
    name: "publish_blog_post",
    title: "Publish an IJSDS blog post (live)",
    description: "Put a draft live on the public IJSDS website. ONLY call this when the editor has explicitly told you to publish this specific post in this conversation (for example \"publish it\"). Never publish on your own initiative, after drafting, or because the editor approved the text. Quote the editor's words in editor_instruction. Returns the public url.",
    inputSchema: {
      type: "object",
      required: ["id", "editor_instruction"],
      properties: {
        ...ID,
        editor_instruction: { type: "string", minLength: 3, maxLength: 500, description: "The editor's exact words asking you to publish." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (svc, a) => svc.publish(a.id, { instruction: a.editor_instruction }),
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS =
  "Writes blog posts for the International Journal of Social Work and Development Studies (IJSDS). " +
  "New posts are saved as drafts. Only call publish_blog_post when the editor explicitly tells you to publish. Never invent studies, statistics, quotes or DOIs.";

/** Express handler for POST /mcp/:key. `limits` are rate limiters keyed "read" and "write". */
export function makeMcpHandler(service, { read, write }) {
  const listed = TOOLS.map(({ run, ...tool }) => tool);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  const callTool = async (params = {}) => {
    const tool = byName.get(params.name);
    if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${params.name}` } };
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const limiter = tool.annotations.readOnlyHint ? read : write;
    if (!limiter()) return toolError("Rate limit reached for this hour. Try again later.");
    if ("id" in tool.inputSchema.properties && !UUID_RE.test(String(args.id ?? ""))) return toolError("Post not found: id must be a post id from list_blog_posts.");
    try {
      const data = await tool.run(service, args);
      return { result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false } };
    } catch (err) {
      if (err.status && err.status < 500) return toolError(err.message);
      console.error("[agent-mcp] tool failed:", params.name, err.message);
      return toolError("The IJSDS server hit an error. Try again shortly.");
    }
  };

  const toolError = (message) => ({ result: { content: [{ type: "text", text: message }], isError: true } });

  const handleMessage = async (msg) => {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    let out;
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        out = {
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "ijsds-blog", title: "IJSDS Blog", version: "1.0.0" },
            instructions: INSTRUCTIONS,
          },
        };
        break;
      }
      case "ping":
        out = { result: {} };
        break;
      case "tools/list":
        out = { result: { tools: listed } };
        break;
      case "tools/call":
        out = await callTool(msg.params);
        break;
      default:
        if (msg.method.startsWith("notifications/")) return null;
        out = { rpcError: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
    if (isNotification) return null;
    return out.rpcError ? { jsonrpc: "2.0", id: msg.id, error: out.rpcError } : { jsonrpc: "2.0", id: msg.id, result: out.result };
  };

  return async (req, res, next) => {
    try {
      const ok = keyMatches(req.params.key);
      if (ok === null) return res.status(503).json({ error: "AI blog access is not configured" });
      if (!ok) return res.status(404).json({ error: "Not found" });
      if (req.method !== "POST") return res.set("Allow", "POST").status(405).json({ error: "Use POST" });

      const body = req.body;
      if (Array.isArray(body)) {
        const replies = (await Promise.all(body.map(handleMessage))).filter(Boolean);
        return replies.length ? res.json(replies) : res.status(202).end();
      }
      const reply = await handleMessage(body);
      return reply ? res.json(reply) : res.status(202).end();
    } catch (err) {
      next(err);
    }
  };
}
