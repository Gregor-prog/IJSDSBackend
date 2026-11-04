import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { makeConsoleRouter } = await import("../src/modules/console/console.routes.js");
const { makeConsoleService } = await import("../src/modules/console/console.service.js");

const TOKEN = "t".repeat(48);

async function serve(service) {
  const app = express();
  app.use("/console", makeConsoleRouter(service));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/console`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("console routes fail closed and require the exact token", async () => {
  const calls = [];
  const service = { summary: async () => ({ ok: 1 }), submissions: async (a) => (calls.push(a), { submissions: [] }) };
  const { base, close } = await serve(service);
  const original = process.env.ADMIN_CONSOLE_TOKEN;
  try {
    delete process.env.ADMIN_CONSOLE_TOKEN;
    assert.equal((await fetch(`${base}/summary`, { headers: { "x-console-token": TOKEN } })).status, 503);

    process.env.ADMIN_CONSOLE_TOKEN = TOKEN;
    assert.equal((await fetch(`${base}/summary`)).status, 401);
    assert.equal((await fetch(`${base}/summary`, { headers: { "x-console-token": TOKEN + "x" } })).status, 401);
    const ok = await fetch(`${base}/summary`, { headers: { "x-console-token": TOKEN } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: 1 });

    // Paging is clamped and unknown statuses are ignored.
    await fetch(`${base}/submissions?page=-4&limit=999&status=drop_table`, { headers: { "x-console-token": TOKEN } });
    assert.deepEqual(calls.at(-1), { page: 1, limit: 50, status: undefined });
    await fetch(`${base}/submissions?status=under_review&limit=10`, { headers: { "x-console-token": TOKEN } });
    assert.deepEqual(calls.at(-1), { page: 1, limit: 10, status: "under_review" });

    // Read-only: no write verbs.
    assert.equal((await fetch(`${base}/summary`, { method: "POST", headers: { "x-console-token": TOKEN } })).status, 404);
  } finally {
    process.env.ADMIN_CONSOLE_TOKEN = original;
    await close();
  }
});

test("submissions list returns counts, never review text or contact details", async () => {
  const past = new Date(Date.now() - 86400000), future = new Date(Date.now() + 86400000);
  const db = {
    submission: {
      findMany: async (args) => {
        assert.equal(args.select.cover_letter, undefined);
        assert.deepEqual(Object.keys(args.select.submitter.select), ["full_name", "affiliation"]);
        return [{
          id: "s1", status: "under_review", submission_type: "new", submitted_at: past, updated_at: past,
          article: { title: "Water access in Rivers State" },
          submitter: { full_name: "Ada Obi", affiliation: "UNIPORT" },
          reviews: [
            { invitation_status: "accepted", submitted_at: null, deadline_date: past },
            { invitation_status: "accepted", submitted_at: null, deadline_date: future },
            { invitation_status: "accepted", submitted_at: past, deadline_date: past },
            { invitation_status: "pending", submitted_at: null, deadline_date: past },
          ],
        }];
      },
      count: async () => 1,
    },
  };
  const out = await makeConsoleService(db).submissions({ page: 1, limit: 25 });
  assert.deepEqual(out.submissions[0], {
    id: "s1", status: "under_review", submission_type: "new", submitted_at: past, updated_at: past,
    title: "Water access in Rivers State", author: "Ada Obi", affiliation: "UNIPORT",
    reviews: { total: 4, submitted: 1, overdue: 1 },
  });
  assert.deepEqual(out.pagination, { page: 1, limit: 25, total: 1, totalPages: 1 });
});

test("summary shapes grouped counts and Crossref states", async () => {
  const n = async () => 2;
  const db = {
    submission: { groupBy: async () => [{ status: "submitted", _count: { _all: 5 } }, { status: "accepted", _count: { _all: 3 } }], count: n },
    review: { count: n },
    article: {
      count: n,
      groupBy: async () => [{ crossref_status: "REGISTERED", _count: { _all: 7 } }, { crossref_status: null, _count: { _all: 4 } }, { crossref_status: "FAILED", _count: { _all: 1 } }],
    },
    profile: { count: n },
    reviewerApplication: { count: n },
    manuscript: { groupBy: async () => [{ current_state: "IN_PEER_REVIEW", _count: { _all: 6 } }] },
    paymentLedger: { aggregate: async () => ({ _count: { _all: 3 }, _sum: { amount_naira: "45000.00" } }), count: async () => 1 },
  };
  const s = await makeConsoleService(db).summary();
  assert.deepEqual(s.submissions.byStatus, { submitted: 5, accepted: 3 });
  assert.deepEqual(s.articles.crossref, { registered: 7, pending: 0, failed: 1, notDeposited: 4 });
  assert.deepEqual(s.ijsds2.payments30d, { count: 3, naira: 45000 });
  assert.equal(s.ijsds2.paymentsNeedingReview, 1);
  assert.deepEqual(s.ijsds2.manuscriptsByState, { IN_PEER_REVIEW: 6 });
});
