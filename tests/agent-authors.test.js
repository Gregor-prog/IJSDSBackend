import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { makeAgentAuthorsRouter } = await import("../src/modules/agent-authors/agent-authors.routes.js");
const { makeAuthorDirectory } = await import("../src/modules/agent-authors/agent-authors.service.js");
const { makeAgentBlogRouter } = await import("../src/modules/agent-blog/agent-blog.routes.js");

const KEY = "a".repeat(48);
const BLOG_KEY = "b".repeat(48);

async function serve(directory) {
  const app = express();
  app.use("/api/agent/authors", makeAgentAuthorsRouter(directory));
  app.use("/api/agent", makeAgentBlogRouter({ list: async () => ({ posts: [] }) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/agent`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("author directory: own key, read-only, and the blog key can't open it", async () => {
  const calls = [];
  const dir = {
    list: async (q) => (calls.push(["list", q]), { total: 0, authors: [] }),
    check: async (e) => (calls.push(["check", e]), { results: [] }),
  };
  const { base, close } = await serve(dir);
  const saved = [process.env.AGENT_AUTHORS_KEY, process.env.AGENT_BLOG_KEY];
  const h = (k) => ({ "x-agent-key": k, "content-type": "application/json" });
  try {
    delete process.env.AGENT_AUTHORS_KEY;
    process.env.AGENT_BLOG_KEY = BLOG_KEY;
    assert.equal((await fetch(`${base}/authors`, { headers: h(KEY) })).status, 503);

    process.env.AGENT_AUTHORS_KEY = KEY;
    assert.equal((await fetch(`${base}/authors`)).status, 401);
    assert.equal((await fetch(`${base}/authors`, { headers: h(BLOG_KEY) })).status, 401);
    assert.equal((await fetch(`${base}/authors?q=ada`, { headers: h(KEY) })).status, 200);
    assert.equal((await fetch(`${base}/authors/check`, { method: "POST", headers: h(KEY), body: JSON.stringify({ emails: ["x@y.org"] }) })).status, 200);
    // The authors key doesn't open the blog either.
    assert.equal((await fetch(`${base}/blog/posts`, { headers: h(KEY) })).status, 401);
    // Nothing writes.
    for (const method of ["POST", "PATCH", "DELETE"]) {
      assert.equal((await fetch(`${base}/authors`, { method, headers: h(KEY), body: "{}" })).status, 404);
    }
    assert.deepEqual(calls.map((c) => c[0]), ["list", "check"]);
    assert.equal(calls[0][1].q, "ada");

    // MCP: wrong key 404, tools are the two read-only ones.
    const rpc = (key, body) => fetch(`${base}/authors/mcp/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await rpc(BLOG_KEY, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
    const tools = (await (await rpc(KEY, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ["list_ijsds_authors", "check_ijsds_authors"]);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    const call = await (await rpc(KEY, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_ijsds_authors", arguments: { emails: ["x@y.org"] } } })).json();
    assert.equal(call.result.isError, false);
    assert.deepEqual(calls.at(-1), ["check", ["x@y.org"]]);
  } finally {
    [process.env.AGENT_AUTHORS_KEY, process.env.AGENT_BLOG_KEY] = saved;
    if (saved[0] === undefined) delete process.env.AGENT_AUTHORS_KEY;
    if (saved[1] === undefined) delete process.env.AGENT_BLOG_KEY;
    await close();
  }
});

test("author directory merges submitters, corresponding and co-authors, and flags opt-outs", async () => {
  const d1 = new Date("2026-03-01T00:00:00Z");
  const d2 = new Date("2026-09-01T00:00:00Z");
  const prisma = {
    submission: {
      findMany: async () => [
        {
          article_id: "A1", submitted_at: d1,
          submitter: { email: "Ada@Uni.edu", full_name: "Ada Obi", affiliation: "RSU" },
          article: { status: "published", corresponding_author_email: "ada@uni.edu", authors: [{ name: "Ada Obi", email: "ada@uni.edu" }, { first_name: "Ken", last_name: "Eze", email: "ken@uni.edu" }, { name: "No Email" }] },
        },
        // A revision of the same paper must not count as a second paper.
        { article_id: "A1", submitted_at: d2, submitter: { email: "ada@uni.edu", full_name: "Ada Obi" }, article: { status: "published", corresponding_author_email: "ada@uni.edu", authors: [] } },
        { article_id: "A2", submitted_at: d2, submitter: null, article: { status: "under_review", corresponding_author_email: "ken@uni.edu", authors: "not-an-array" } },
      ],
    },
    profile: { findMany: async () => [{ email: "KEN@uni.edu" }] },
    blogSubscriber: { findMany: async () => [] },
  };
  const dir = makeAuthorDirectory(prisma);
  const { total, authors } = await dir.list();
  assert.equal(total, 2);
  const ada = authors.find((a) => a.email === "ada@uni.edu");
  const ken = authors.find((a) => a.email === "ken@uni.edu");
  assert.deepEqual(ada.roles, ["corresponding_author", "submitter"]);
  assert.equal(ada.papers_submitted, 1);
  assert.equal(ada.papers_published, 1);
  assert.equal(ada.first_submitted_at, d1.toISOString());
  assert.equal(ada.last_submitted_at, d2.toISOString());
  assert.equal(ada.email_opt_out, false);
  assert.equal(ken.name, "Ken Eze");
  assert.equal(ken.papers_submitted, 2);
  assert.equal(ken.papers_published, 1);
  assert.equal(ken.email_opt_out, true);
  // Nothing beyond the narrow fields leaks out.
  assert.deepEqual(Object.keys(ada).sort(), ["affiliation", "email", "email_opt_out", "first_submitted_at", "last_submitted_at", "name", "papers_published", "papers_submitted", "roles"]);

  assert.equal((await dir.list({ q: "eze" })).total, 1);
  const { results } = await dir.check([" ADA@uni.edu ", "new@person.org"]);
  assert.equal(results[0].is_author, true);
  assert.deepEqual(results[1], { email: "new@person.org", is_author: false });
  await assert.rejects(dir.check([]), /non-empty/);
});
