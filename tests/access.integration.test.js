// HTTP-level access checks for public/"any logged-in user" routes (real Express app + real Postgres).
//   IJSDS2_TEST_DATABASE_URL=postgresql://... node --test --test-force-exit tests/access.integration.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.IJSDS2_TEST_DATABASE_URL;
const T = { skip: !URL };
if (URL) {
  process.env.DATABASE_URL = URL;
  process.env.DATABASE_SSL = "false";
  process.env.JWT_SECRET = "access-test-secret";
  process.env.REDIS_URL = "redis://127.0.0.1:1";
}

let base, prisma, jwt, ctx = {};
const RUN = Date.now();

test("setup", T, async () => {
  const app = (await import("../app.js")).default;
  prisma = (await import("../src/config/prisma.js")).default;
  jwt = (await import("jsonwebtoken")).default;
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (tag, extra = {}) => {
    const p = await prisma.profile.create({ data: { email: `${tag}-${RUN}@t.io`, full_name: tag, ...extra } });
    return { ...p, tok: jwt.sign({ id: p.id, role: p.role }, "access-test-secret") };
  };
  ctx.author = await mk("author");
  ctx.reviewer = await mk("reviewer", { is_reviewer: true, role: "reviewer" });
  ctx.stranger = await mk("stranger");
  ctx.editor = await mk("editor", { is_editor: true, role: "editor" });

  const authors = [{ name: "A One", email: `coauthor-${RUN}@t.io` }];
  ctx.unpub = await prisma.article.create({ data: { title: `Unpublished ${RUN}`, abstract: "x", authors, corresponding_author_email: "corr@t.io", status: "submitted", manuscript_file_url: "https://f/secret.pdf" } });
  ctx.pub = await prisma.article.create({ data: { title: `Published ${RUN}`, abstract: "y", authors, corresponding_author_email: "corr@t.io", status: "published", manuscript_file_url: "https://f/public.pdf", vetting_fee: true } });
  ctx.sub = await prisma.submission.create({ data: { article_id: ctx.unpub.id, submitter_id: ctx.author.id } });
  await prisma.review.create({ data: { submission_id: ctx.sub.id, reviewer_id: ctx.reviewer.id } });
  await prisma.fileVersion.create({ data: { article_id: ctx.unpub.id, file_url: "https://f/secret-v2.pdf", file_name: "v2.pdf", file_type: "application/pdf", uploaded_by: ctx.author.id } });
  await prisma.revisionRequest.create({ data: { submission_id: ctx.sub.id, requested_by: ctx.editor.id, revision_type: "minor", request_details: "fix x" } });
});

const get = (path, who) => fetch(base + path, { headers: who ? { Authorization: `Bearer ${who.tok}` } : {} });
const json = async (path, who) => { const r = await get(path, who); return { status: r.status, body: await r.json().catch(() => null) }; };

test("article list: public sees published only, without private fields; staff sees everything", T, async () => {
  const anon = await json("/api/articles");
  const ids = anon.body.data.map((a) => a.id);
  assert.ok(ids.includes(ctx.pub.id));
  assert.ok(!ids.includes(ctx.unpub.id), "unpublished must not be listed publicly");
  assert.deepEqual((await json("/api/articles?status=submitted")).body.data, [], "asking for another status gets nothing");
  const pub = anon.body.data.find((a) => a.id === ctx.pub.id);
  assert.equal(pub.vetting_fee, undefined);
  assert.equal(pub.submissions, undefined);
  assert.equal(pub.authors[0].email, undefined, "co-author emails hidden");
  assert.equal(pub.corresponding_author_email, "corr@t.io", "corresponding author stays (printed on the paper)");
  assert.ok((await json("/api/articles?status=submitted", ctx.stranger)).body.data.length === 0, "logged-in non-staff also only see published");
  const staff = await json("/api/articles?status=submitted", ctx.editor);
  assert.ok(staff.body.data.some((a) => a.id === ctx.unpub.id));
  assert.equal(staff.body.data.find((a) => a.id === ctx.unpub.id).authors[0].email, `coauthor-${RUN}@t.io`);
});

test("single article + files: unpublished visible only to staff, its author and its reviewers", T, async () => {
  for (const who of [null, ctx.stranger]) {
    assert.equal((await json(`/api/articles/${ctx.unpub.id}`, who)).status, 404);
    assert.equal((await json(`/api/files/${ctx.unpub.id}/latest`, who)).status, 404);
  }
  for (const who of [ctx.author, ctx.reviewer, ctx.editor]) {
    assert.equal((await json(`/api/articles/${ctx.unpub.id}`, who)).status, 200);
    const f = await json(`/api/files/${ctx.unpub.id}/latest`, who);
    assert.equal(f.status, 200);
    assert.equal(f.body.data.file_url, "https://f/secret-v2.pdf");
  }
  assert.equal((await json(`/api/articles/${ctx.pub.id}`)).status, 200, "published stays public");
  assert.equal((await json(`/api/files/${ctx.unpub.id}`, ctx.stranger)).status, 404, "version list also protected");
  // an expired/garbage token on a public route doesn't break it, it is just anonymous
  const bad = await fetch(base + `/api/articles/${ctx.pub.id}`, { headers: { Authorization: "Bearer not-a-token" } });
  assert.equal(bad.status, 200);
});

test("revision requests and profiles are not readable by strangers", T, async () => {
  assert.equal((await json(`/api/revision-requests/${ctx.sub.id}`, ctx.stranger)).status, 403);
  assert.equal((await json(`/api/revision-requests/${ctx.sub.id}`, ctx.author)).status, 200);
  const other = await json(`/api/profiles/${ctx.editor.id}`, ctx.stranger);
  assert.equal(other.status, 200);
  assert.equal(other.body.data.email, undefined, "no email for other people's profiles");
  assert.equal(other.body.data.is_admin, undefined);
  assert.equal(other.body.data.full_name, "editor");
  assert.equal((await json(`/api/profiles/${ctx.stranger.id}`, ctx.stranger)).body.data.email, `stranger-${RUN}@t.io`, "own profile is complete");
  assert.ok((await json(`/api/profiles/${ctx.author.id}`, ctx.editor)).body.data.email, "staff see everything");
});
