import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { makeAgentBlogRouter } = await import("../src/modules/agent-blog/agent-blog.routes.js");
const { cleanPostInput } = await import("../src/modules/agent-blog/agent-blog.service.js");

const KEY = "k".repeat(48);
const ID = "3f1c2a9e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";

async function serve(service, opts) {
  const app = express();
  app.use(express.json());
  app.use("/api/agent", makeAgentBlogRouter(service, opts));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/agent`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const fakeService = (calls = []) => ({
  list: async (a) => (calls.push(["list", a]), { posts: [] }),
  get: async (id) => (calls.push(["get", id]), { id }),
  create: async (b) => (calls.push(["create", b]), { id: ID, ...b }),
  update: async (id, b) => (calls.push(["update", id, b]), { id, ...b }),
});

test("agent blog routes fail closed, need the exact key, and expose only the blog", async () => {
  const calls = [];
  const { base, close } = await serve(fakeService(calls));
  const original = process.env.AGENT_BLOG_KEY;
  const h = (k = KEY) => ({ "x-agent-key": k, "content-type": "application/json" });
  try {
    delete process.env.AGENT_BLOG_KEY;
    assert.equal((await fetch(`${base}/blog/posts`, { headers: h() })).status, 503);
    process.env.AGENT_BLOG_KEY = "short";
    assert.equal((await fetch(`${base}/blog/posts`, { headers: h("short") })).status, 503);

    process.env.AGENT_BLOG_KEY = KEY;
    assert.equal((await fetch(`${base}/blog/posts`)).status, 401);
    assert.equal((await fetch(`${base}/blog/posts`, { headers: h(KEY + "x") })).status, 401);
    assert.equal((await fetch(`${base}/blog/posts`, { headers: h() })).status, 200);

    const created = await fetch(`${base}/blog/posts`, { method: "POST", headers: h(), body: JSON.stringify({ title: "T", content: "<p>x</p>" }) });
    assert.equal(created.status, 201);
    assert.equal((await fetch(`${base}/blog/posts/${ID}`, { method: "PATCH", headers: h(), body: JSON.stringify({ status: "draft" }) })).status, 200);
    assert.equal((await fetch(`${base}/blog/posts/not-a-uuid`, { headers: h() })).status, 404);

    // No delete, and nothing outside the blog posts routes.
    assert.equal((await fetch(`${base}/blog/posts/${ID}`, { method: "DELETE", headers: h() })).status, 404);
    assert.equal((await fetch(`${base}/articles`, { headers: h() })).status, 404);
    assert.deepEqual(calls.map((c) => c[0]), ["list", "create", "update"]);

    // The OpenAPI document is public and names only the blog endpoints.
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.deepEqual(Object.keys(spec.paths).sort(), ["/api/agent/blog/posts", "/api/agent/blog/posts/{id}"]);
    assert.equal(spec.components.securitySchemes.AgentKey.name, "x-agent-key");
    assert.ok(Object.values(spec.paths).flatMap((p) => Object.values(p)).every((op) => op.operationId));
  } finally {
    if (original === undefined) delete process.env.AGENT_BLOG_KEY; else process.env.AGENT_BLOG_KEY = original;
    await close();
  }
});

test("agent blog writes are rate limited", async () => {
  const { base, close } = await serve(fakeService(), { writesPerHour: 2 });
  const original = process.env.AGENT_BLOG_KEY;
  process.env.AGENT_BLOG_KEY = KEY;
  try {
    const post = () => fetch(`${base}/blog/posts`, { method: "POST", headers: { "x-agent-key": KEY, "content-type": "application/json" }, body: "{}" });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  } finally {
    if (original === undefined) delete process.env.AGENT_BLOG_KEY; else process.env.AGENT_BLOG_KEY = original;
    await close();
  }
});

test("agent post input is validated and its HTML sanitized", () => {
  const out = cleanPostInput({
    title: "  Hello  ",
    content: '<h1>Top</h1><p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://ijsds.org">ok</a></p><script>alert(1)</script><img src="http://x/y.png"><iframe src="https://e"></iframe>',
    excerpt: "<b>Short</b> summary",
    tags: ["a", "a", "b"],
  });
  assert.equal(out.title, "Hello");
  assert.equal(out.status, "published");
  assert.doesNotMatch(out.content, /script|onclick|javascript|iframe|<img/i);
  assert.match(out.content, /<h2>Top<\/h2>/);
  assert.match(out.content, /<a href="https:\/\/ijsds.org" rel="noopener noreferrer" target="_blank">ok<\/a>/);
  assert.equal(out.excerpt, "Short summary");
  assert.deepEqual(out.tags, ["a", "b"]);

  const bad = (body, re, opts) => assert.throws(() => cleanPostInput(body, opts), (e) => Boolean(e.status === 400 && re.test(e.message)));
  bad({ content: "<p>x</p>" }, /title is required/);
  bad({ title: "T" }, /content is required/);
  bad({ title: "T", content: "<script>x</script>" }, /no allowed text/);
  bad({ title: "x".repeat(201), content: "<p>x</p>" }, /title must be at most/);
  bad({ title: "T", content: "<p>x</p>", status: "deleted" }, /status must be/);
  bad({ title: "T", content: "<p>x</p>", featured_image_url: "http://insecure/x.png" }, /https/);
  bad({ title: "T", content: "<p>x</p>", tags: Array(11).fill("t") }, /tags/);
  bad({ title: 5, content: "<p>x</p>" }, /must be a string/);

  // Updates accept any subset and don't default the status.
  assert.deepEqual(cleanPostInput({ status: "draft" }, { partial: true }), { status: "draft" });
});

test("MCP plugin endpoint: key in the URL, protocol handshake, tools, errors", async () => {
  const calls = [];
  const { base, close } = await serve(fakeService(calls), { writesPerHour: 1 });
  const original = process.env.AGENT_BLOG_KEY;
  const rpc = (key, body) => fetch(`${base}/mcp/${key}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://chatgpt.com" }, body: JSON.stringify(body) });
  try {
    delete process.env.AGENT_BLOG_KEY;
    assert.equal((await rpc(KEY, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 503);
    process.env.AGENT_BLOG_KEY = KEY;
    assert.equal((await rpc(KEY + "x", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
    assert.equal((await fetch(`${base}/mcp/${KEY}`)).status, 405);

    const init = await (await rpc(KEY, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities.tools);
    assert.equal((await rpc(KEY, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

    const tools = (await (await rpc(KEY, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ["list_blog_posts", "get_blog_post", "create_blog_post", "update_blog_post"]);
    assert.ok(tools.every((t) => t.inputSchema && !("run" in t)));
    assert.equal(tools.find((t) => t.name === "create_blog_post").annotations.readOnlyHint, false);

    const call = async (name, args, id = 3) => (await (await rpc(KEY, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).json());
    const created = await call("create_blog_post", { title: "T", content: "<p>x</p>" });
    assert.equal(created.result.isError, false);
    assert.equal(created.result.structuredContent.title, "T");
    assert.equal(JSON.parse(created.result.content[0].text).id, ID);

    // writesPerHour is 1: the second write is refused as a tool error, reads still work.
    const limited = await call("update_blog_post", { id: ID, status: "draft" });
    assert.equal(limited.result.isError, true);
    assert.match(limited.result.content[0].text, /Rate limit/);
    assert.equal((await call("get_blog_post", { id: "nope" })).result.isError, true);
    assert.equal((await call("get_blog_post", { id: ID })).result.isError, false);

    assert.equal((await call("delete_blog_post", { id: ID })).error.code, -32602);
    assert.equal((await (await rpc(KEY, { jsonrpc: "2.0", id: 9, method: "resources/list" })).json()).error.code, -32601);
    assert.deepEqual(calls.map((c) => c[0]), ["create", "get"]);
  } finally {
    if (original === undefined) delete process.env.AGENT_BLOG_KEY; else process.env.AGENT_BLOG_KEY = original;
    await close();
  }
});
