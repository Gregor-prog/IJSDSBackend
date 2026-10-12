// End-to-end lifecycle against a REAL Postgres+pgvector (never production).
//   IJSDS2_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:55432/ijsds \
//   node --experimental-test-module-mocks --test --test-force-exit tests/ijsds2.integration.test.js
// Skipped unless IJSDS2_TEST_DATABASE_URL is set. Paystack/Crossref/OpenAlex/file download
// are mocked; the database is not.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const URL = process.env.IJSDS2_TEST_DATABASE_URL;
const skip = !URL;
if (!skip) {
  process.env.DATABASE_URL = URL;
  process.env.DATABASE_SSL = "false";
  process.env.PAYSTACK_SECRET_KEY_LIVE = "sk_test_unit";
  process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
  process.env.REDIS_URL = "redis://127.0.0.1:1"; // queue unavailable: DB sweeper path
}

let DOC = "";
// Varied prose: the dev heuristic flags repeated 8-grams, so don't repeat sentences.
const filler = Array.from({ length: 60 }, (_, i) => `Observation ${i} records how household ${i * 7} and district ${i * 3} experienced welfare programme ${i * 11} differently.`).join(" ");
const BODY_OK = `${filler}
Poverty and welfare in Lagos has been studied extensively (Okafor, 2020). Community care models matter [2].

Ethical approval was obtained from the institutional review board and participants gave informed consent.

References
[1] Okafor, C. (2020). Poverty and welfare in Lagos. Journal of Social Work. doi:10.1234/okafor.2020
[2] Adeyemi, T. (2019). Community care models in Nigeria. African Social Review.
`;
const BODY_NO_ETHICS = BODY_OK.replace(/Ethical approval[^\n]*\n/, "Methods were standard.\n");

if (!skip) {
  const real = await import("../src/modules/ijsds2/manuscriptParser.js");
  mock.module("../src/modules/ijsds2/manuscriptParser.js", {
    namedExports: { ...real, fetchFileBuffer: async () => Buffer.from("x"), extractText: async () => DOC },
  });
}

const RUN = Date.now(); // makes Paystack references unique across runs on a reused DB
const R = (n) => `${RUN}_${n}`;
const paystack = {}; // reference -> data
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
  if (u.includes("api.paystack.co/transaction/verify/")) {
    const ref = decodeURIComponent(u.split("/verify/")[1]);
    return paystack[ref] ? json({ status: true, data: paystack[ref] }) : json({ status: false }, 404);
  }
  if (u.includes("api.crossref.org/works/10.1234")) {
    return json({ message: { DOI: "10.1234/okafor.2020", title: ["Poverty and welfare in Lagos"], issued: { "date-parts": [[2020]] } } });
  }
  if (u.includes("api.crossref.org/works?query.bibliographic")) {
    return json({ message: { items: [{ DOI: "10.5555/adeyemi.2019", title: ["Community care models in Nigeria"], issued: { "date-parts": [[2019]] } }] } });
  }
  if (u.includes("api.openalex.org/works/doi:")) {
    return json({ id: "https://openalex.org/W1", related_works: ["https://openalex.org/W9"], referenced_works: [], abstract_inverted_index: null });
  }
  if (u.includes("api.openalex.org/works?filter")) {
    return json({ results: [{ id: "https://openalex.org/W9", doi: "https://doi.org/10.7777/related", title: "Community welfare in Nigeria", publication_year: 2021, abstract_inverted_index: null }] });
  }
  return json({}, 404);
};

const T = { skip };
let prisma, svc;
const ids = {};

test("setup", T, async () => {
  prisma = (await import("../src/config/prisma.js")).default;
  svc = {
    sub: await import("../src/modules/submissions/submissions.service.js"),
    pay: await import("../src/modules/ijsds2/payments.service.js"),
    audit: await import("../src/modules/ijsds2/audit.service.js"),
    match: await import("../src/modules/ijsds2/matching.service.js"),
    ms: await import("../src/modules/ijsds2/manuscripts.service.js"),
    batch: await import("../src/modules/ijsds2/batch.service.js"),
  };
  const mk = (email, extra = {}) => prisma.profile.create({ data: { email, full_name: email.split("@")[0], ...extra } });
  ids.author = (await mk(`author-${Date.now()}@t.io`)).id;
  ids.refUser = (await mk(`ref-${Date.now()}@t.io`, { is_reviewer: true, role: "reviewer" })).id;
  ids.revUser = (await mk(`rev-${Date.now()}@t.io`, { is_reviewer: true, role: "reviewer" })).id;
  ids.editor = (await mk(`ed-${Date.now()}@t.io`, { is_editor: true, role: "editor" })).id;
  const referrer = await svc.ms.getOrCreateReviewerProfile(ids.refUser);
  const other = await svc.ms.getOrCreateReviewerProfile(ids.revUser);
  await prisma.reviewerProfile.update({ where: { id: referrer.id }, data: { expertise_keywords: ["social work", "welfare"] } });
  await prisma.reviewerProfile.update({ where: { id: other.id }, data: { expertise_keywords: ["social work", "welfare"] } });
  ids.referrerProfile = referrer.id;
  ids.otherProfile = other.id;
  ids.code = referrer.referral_code;
});

const tx = (ref, naira, extra = {}) => ({
  status: "success", currency: "NGN", amount: Math.round(naira * 100), reference: ref,
  customer: { email: "x" },
  metadata: { custom_fields: [{ variable_name: "submitter_id", value: ids.author }, ...(extra.fields ?? [])] },
});

test("submission creates a manuscript in DRAFT_PENDING_FEE1 with the referrer recorded; self-referral ignored", T, async () => {
  const sub = await svc.sub.createSubmission(
    { title: "Welfare in Lagos", abstract: "A study of community welfare and social work practice in Lagos, Nigeria — long enough abstract text here.", authors: [{ name: "A" }], corresponding_author_email: "a@t.io", keywords: ["welfare"], referral_code: ids.code },
    ids.author, "https://files.example/m.docx",
  );
  ids.sub = sub.id;
  ids.article = sub.article.id;
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  ids.ms = m.id;
  assert.equal(m.current_state, "DRAFT_PENDING_FEE1");
  assert.equal(m.referred_by_reviewer_id, ids.referrerProfile);

  // the referrer submitting with their own code gets no referral
  const own = await svc.sub.createSubmission(
    { title: "Own", abstract: "x".repeat(80), authors: [{ name: "R" }], corresponding_author_email: "r@t.io", referral_code: ids.code },
    ids.refUser, null,
  );
  assert.equal((await prisma.manuscript.findUnique({ where: { submission_id: own.id } })).referred_by_reviewer_id, null);
});

test("Gate 1: wrong amount / wrong payer rejected; correct payment schedules a 24h audit; idempotent", T, async () => {
  paystack[R("G1_LOW")] = tx(R("G1_LOW"), 4999);
  paystack[R("G1_HIGH")] = tx(R("G1_HIGH"), 5300);
  await assert.rejects(svc.pay.settlePayment({ reference: R("G1_HIGH"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author }), /Amount mismatch/);
  await assert.rejects(svc.pay.settlePayment({ reference: R("G1_LOW"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author }), /Amount mismatch/);

  paystack[R("G1")] = tx(R("G1"), 5178); // grossed-up checkout amount
  await assert.rejects(svc.pay.settlePayment({ reference: R("G1"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.editor }), /author/);

  const r = await svc.pay.settlePayment({ reference: R("G1"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author });
  assert.equal(r.revisionNo, 1);
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "IN_AUDIT");
  const hours = (m.audit_scheduled_for - Date.now()) / 3600e3;
  assert.ok(hours > 23.9 && hours <= 24.01, `scheduled in ${hours}h`);
  assert.equal((await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: ids.ms } })).status, "QUEUED");
  assert.equal((await prisma.article.findUnique({ where: { id: ids.article } })).vetting_fee, true);

  const again = await svc.pay.settlePayment({ reference: R("G1"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author });
  assert.equal(again.alreadyProcessed, true);
  assert.equal(await prisma.paymentLedger.count({ where: { manuscript_id: ids.ms } }), 1);

  // a second, different payment for an already-moved manuscript is parked, not applied
  paystack[R("G1_DUP")] = tx(R("G1_DUP"), 5178);
  const dup = await svc.pay.settlePayment({ reference: R("G1_DUP"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author });
  assert.equal(dup.needsReview, true);
  assert.equal((await prisma.paymentLedger.findUnique({ where: { gateway_reference: R("G1_DUP") } })).status, "needs_review");
});

test("audit is not run before its 24h window; runs when due (revision 1 -> revision requested)", T, async () => {
  DOC = BODY_NO_ETHICS;
  assert.deepEqual(await svc.audit.runIntegrityAudit({ manuscriptId: ids.ms, revisionNo: 1 }), { skipped: "not due yet" });
  await prisma.manuscript.update({ where: { id: ids.ms }, data: { audit_scheduled_for: new Date(Date.now() - 1000) } });
  const r = await svc.audit.runIntegrityAudit({ manuscriptId: ids.ms, revisionNo: 1 });
  assert.equal(r.outcome, "AUDIT_REVISION_REQUESTED");
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "AUDIT_REVISION_REQUESTED");
  const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: ids.ms, revision_no: 1 } });
  assert.equal(a.status, "COMPLETED");
  assert.equal(a.plagiarism_provider, "heuristic-dev");
  assert.ok(a.policy_rules_hit.includes("RULE_MISSING_ETHICS_DECLARATION"));
  assert.ok((await prisma.manuscriptCitation.count({ where: { audit_id: a.id } })) === 2);
  // every recommendation carries a stable identifier from a real record
  const recs = await prisma.citationRecommendation.findMany({ where: { audit_id: a.id } });
  assert.ok(recs.length >= 1 && recs.every((x) => x.doi || x.external_work_id));
  // a concurrent/second run is a no-op
  assert.ok((await svc.audit.runIntegrityAudit({ manuscriptId: ids.ms, revisionNo: 1, force: true })).skipped);
});

test("author report hides internals and raw AI score; staff see them", T, async () => {
  const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: ids.ms, revision_no: 1 } });
  const author = await svc.audit.buildAuthorReport(a.id, { staff: false });
  assert.equal(author.internal, undefined);
  assert.equal("score" in author.aiAuthorship, false);
  assert.match(author.aiAuthorship.disclaimer, /not conclusive evidence/);
  const staff = await svc.audit.buildAuthorReport(a.id, { staff: true });
  assert.ok(staff.internal);
});

test("revision loop: free re-upload creates audit rev 2 (history kept), no new fee", T, async () => {
  const m0 = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  await prisma.$transaction((db) => svc.audit.scheduleAuditTx(db, m0, { actorId: ids.author, reason: "rev" }));
  assert.equal(await prisma.manuscriptIntegrityAudit.count({ where: { manuscript_id: ids.ms } }), 2);
  assert.equal(await prisma.paymentLedger.count({ where: { manuscript_id: ids.ms, payment_type: "EVALUATION_FEE", status: "success" } }), 1);
  DOC = BODY_OK;
  await prisma.manuscript.update({ where: { id: ids.ms }, data: { audit_scheduled_for: new Date(Date.now() - 1000) } });
  const r = await svc.audit.runIntegrityAudit({ manuscriptId: ids.ms, revisionNo: 2 });
  assert.equal(r.outcome, "AUDIT_PASSED_PENDING_APC");
  assert.equal((await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: ids.ms, revision_no: 1 } })).decision, "AUDIT_REVISION_REQUESTED");
});

test("provider outage never clears: unconfigured provider -> MANUAL_REVIEW, manuscript stays IN_AUDIT; editor override is attributed", T, async () => {
  // fresh manuscript through Gate 1
  const sub = await svc.sub.createSubmission({ title: "Second", abstract: "y".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, ids.author, "https://f/x.docx");
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  paystack[R("G1B")] = tx(R("G1B"), 5000); // un-grossed net also accepted
  await svc.pay.settlePayment({ reference: R("G1B"), gate: "GATE_1", manuscriptId: m.id, payerUserId: ids.author });
  await prisma.manuscript.update({ where: { id: m.id }, data: { audit_scheduled_for: new Date(Date.now() - 1000) } });
  DOC = BODY_OK;
  delete process.env.INTEGRITY_ALLOW_HEURISTIC;
  const r = await svc.audit.runIntegrityAudit({ manuscriptId: m.id, revisionNo: 1 });
  process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
  assert.equal(r.outcome, "MANUAL_REVIEW");
  const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: m.id } });
  assert.equal(a.status, "MANUAL_REVIEW");
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_AUDIT");
  await assert.rejects(svc.audit.resolveAudit(a.id, { outcome: "AUDIT_PASSED_PENDING_APC", reason: "short" }, { id: ids.editor }), /reason/);
  await svc.audit.resolveAudit(a.id, { outcome: "AUDIT_PASSED_PENDING_APC", reason: "Editor verified originality manually" }, { id: ids.editor });
  const done = await prisma.manuscriptIntegrityAudit.findUnique({ where: { id: a.id } });
  assert.equal(done.resolved_by, ids.editor);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "AUDIT_PASSED_PENDING_APC");
});

test("Gate 2: split ledger sums to 25,500, referral ₦1,000 credited exactly once, state APC_PAID", T, async () => {
  paystack[R("G2")] = tx(R("G2"), 25991);
  await assert.rejects(svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author }), /./); // wrong gate
  const r = await svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_2", manuscriptId: ids.ms, payerUserId: ids.author });
  assert.equal(r.referralCredited, true);
  await svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_2", manuscriptId: ids.ms, payerUserId: ids.author }); // replay
  const d = await prisma.gate2DistributionLedger.findMany({ where: { manuscript_id: ids.ms } });
  assert.equal(d.length, 1);
  assert.equal(Number(d[0].tech_support_naira) + Number(d[0].designer_naira) + Number(d[0].journal_account_naira) + Number(d[0].journal_manager_naira), 25500);
  assert.equal(Number((await prisma.reviewerProfile.findUnique({ where: { id: ids.referrerProfile } })).wallet_balance_naira), 1000);
  assert.equal(await prisma.referralPayoutLedger.count({ where: { manuscript_id: ids.ms } }), 1);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: ids.ms } })).current_state, "APC_PAID");
});

test("reviewer matching: COPE firewall excludes referrer and author at match AND assign time; load cap", T, async () => {
  const { candidates } = await svc.match.matchReviewers(ids.ms, 500);
  const matched = candidates.map((c) => c.reviewerId);
  assert.ok(!matched.includes(ids.referrerProfile), "referrer must be excluded");
  assert.ok(matched.includes(ids.otherProfile));
  await assert.rejects(svc.match.assignReviewers(ids.ms, [ids.refUser], ids.editor), /COPE/);
  await svc.match.assignReviewers(ids.ms, [ids.revUser], ids.editor);
  assert.equal((await prisma.reviewerProfile.findUnique({ where: { id: ids.otherProfile } })).active_load, 1);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: ids.ms } })).current_state, "REVIEWER_MATCHED");
  await assert.rejects(svc.match.assignReviewers(ids.ms, [ids.revUser], ids.editor), /already invited/);
  await prisma.reviewerProfile.update({ where: { id: ids.otherProfile }, data: { active_load: 3 } });
  const again = await svc.match.matchReviewers(ids.ms, 500);
  assert.ok(!again.candidates.some((c) => c.reviewerId === ids.otherProfile), "at load cap");
});

test("legacy editorial statuses are gated by the state machine; nothing publishes except the batch", T, async () => {
  const { syncManuscriptWithArticleStatus } = svc.ms;
  // a manuscript that hasn't cleared audit/paid can't be accepted
  const sub = await svc.sub.createSubmission({ title: "Unpaid", abstract: "z".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, ids.author, null);
  await assert.rejects(prisma.$transaction((db) => syncManuscriptWithArticleStatus(db, sub.article.id, "accepted")), /Gate 2|Stage 2/);

  await prisma.$transaction(async (db) => {
    for (const s of ["accepted", "processed", "ready_for_publication"]) await syncManuscriptWithArticleStatus(db, ids.article, s);
  });
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "READY_FOR_RELEASE");
  assert.ok(m.target_publication_year && m.target_publication_month);
});

test("monthly batch: skips papers without a registered DOI (never fabricates one), publishes those with one, leaves others to roll over", T, async () => {
  let r = await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 });
  assert.equal(r.publishedCount, 0);
  assert.ok(r.skipped.some((s) => s.manuscriptId === ids.ms && /DOI/.test(s.reason)));
  assert.equal((await prisma.manuscript.findUnique({ where: { id: ids.ms } })).doi, null);

  await prisma.article.update({ where: { id: ids.article }, data: { crossrefDoi: `10.62154/ijsds.2.10.${RUN}` } });
  r = await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 });
  assert.deepEqual(r.publishedManuscriptIds, [ids.ms]);
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "PUBLISHED");
  assert.equal(m.doi, `10.62154/ijsds.2.10.${RUN}`);
  const art = await prisma.article.findUnique({ where: { id: ids.article } });
  assert.equal(art.status, "published");
  assert.equal(art.volume, 2);
  assert.equal(art.issue, 10);
  assert.ok(r.rolledOverCount >= 1);
  // republishing is a no-op
  assert.equal((await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 })).publishedCount, 0);
});

test("Global Card track: legacy exact price accepted, Gate 2 split in the same proportions as local", T, async () => {
  const sub = await svc.sub.createSubmission({ title: "Global", abstract: "g".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, ids.author, null);
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  const g = (ref, kobo, gate) => ({ ...tx(ref, 0), amount: kobo, metadata: { custom_fields: [{ variable_name: "submitter_id", value: ids.author }, { variable_name: "billing_track", value: "global" }, { variable_name: "gate", value: gate }] } });
  paystack[R("GL1_BAD")] = g(R("GL1_BAD"), 1_580_001, "GATE_1");
  await assert.rejects(svc.pay.settlePayment({ reference: R("GL1_BAD"), gate: "GATE_1", manuscriptId: m.id, payerUserId: ids.author }), /global track/);
  paystack[R("GL1")] = g(R("GL1"), 1_580_000, "GATE_1");
  await svc.pay.settlePayment({ reference: R("GL1"), gate: "GATE_1", manuscriptId: m.id, payerUserId: ids.author });
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_AUDIT");
  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "AUDIT_PASSED_PENDING_APC" } });
  paystack[R("GL2")] = g(R("GL2"), 4_318_418, "GATE_2");
  const r = await svc.pay.settlePayment({ reference: R("GL2"), gate: "GATE_2", manuscriptId: m.id, payerUserId: ids.author });
  assert.equal(r.splitRecorded, true);
  const d = await prisma.gate2DistributionLedger.findFirst({ where: { manuscript_id: m.id } });
  const parts = [d.tech_support_naira, d.designer_naira, d.journal_account_naira, d.journal_manager_naira].map(Number);
  assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100), 4_318_418, "parts sum to exactly what was collected");
  assert.equal(parts[0], 5080.49); // 3,000/25,500 of 43,184.18
  // the DB itself refuses a split that doesn't match the payment
  await assert.rejects(prisma.gate2DistributionLedger.create({ data: { manuscript_id: m.id, payment_ledger_id: (await prisma.paymentLedger.findFirst({ where: { manuscript_id: m.id, payment_type: "APC" } })).id, tech_support_naira: 1, designer_naira: 1, journal_account_naira: 1, journal_manager_naira: 1 } }), /must equal the linked payment/);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "APC_PAID");
});

test("reviewer flow: authz, implicit accept -> IN_PEER_REVIEW, load released once, no edits after submit", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  const mkP = (email, extra = {}) => prisma.profile.create({ data: { email, full_name: email, ...extra } });
  const rUser = await mkP(`rv-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const stranger = await mkP(`st-${RUN}@t.io`, { role: "author" });
  const author = await mkP(`au-${RUN}@t.io`);
  const sub = await svc.sub.createSubmission({ title: "RF", abstract: "r".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, author.id, null);
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "APC_PAID" } });
  const [review] = await svc.match.assignReviewers(m.id, [rUser.id], ids.editor);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "REVIEWER_MATCHED");
  const load = async () => (await prisma.reviewerProfile.findUnique({ where: { user_id: rUser.id } })).active_load;
  assert.equal(await load(), 1);

  const asUser = (p, role) => ({ id: p.id, role });
  await assert.rejects(rv.updateReview(review.id, { recommendation: "accept" }, asUser(stranger, "author")), /Forbidden/);
  await assert.rejects(rv.getReview(review.id, asUser(stranger, "author")), /Forbidden/);
  await assert.rejects(rv.updateReview(review.id, { deadline_date: "2030-01-01" }, asUser(rUser, "reviewer")), /cannot change/);
  await assert.rejects(rv.getReview(review.id, asUser(author, "author")), /Forbidden/); // not submitted yet

  await rv.updateReview(review.id, { recommendation: "accept", comments_to_author: "Good", submit: true }, asUser(rUser, "reviewer"));
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_PEER_REVIEW");
  assert.equal((await prisma.review.findUnique({ where: { id: review.id } })).invitation_status, "accepted");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await load(), 0);

  await assert.rejects(rv.updateReview(review.id, { comments_to_author: "changed" }, asUser(rUser, "reviewer")), /already been submitted/);
  await assert.rejects(rv.updateReview(review.id, { invitation_status: "declined" }, asUser(rUser, "reviewer")), /already been submitted/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await load(), 0);

  const seen = await rv.getReview(review.id, asUser(author, "author")); // now visible, but anonymised
  assert.equal(seen.comments_to_author, "Good");
  assert.equal(seen.reviewer, undefined);
  assert.equal(seen.comments_to_editor, undefined);
});

test("author revision loop: decision -> AUTHOR_REVISION_REQUESTED -> upload -> round 2 re-review", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  const ed = await import("../src/modules/editorial-decisions/editorial-decisions.service.js");
  const rl = await import("../src/modules/ijsds2/revisions.service.js");
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const r1 = await mkP(`rl1-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const au = await mkP(`rla-${RUN}@t.io`);
  const sub = await svc.sub.createSubmission({ title: "RL", abstract: "l".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, "https://f/old.docx");
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "APC_PAID" } });
  const [review] = await svc.match.assignReviewers(m.id, [r1.id], ids.editor);
  await rv.updateReview(review.id, { recommendation: "minor_revisions", comments_to_author: "Fix", submit: true }, { id: r1.id, role: "reviewer" });
  await ed.createDecision({ submission_id: sub.id, decision_type: "minor_revision", decision_rationale: "see reviews" }, ids.editor);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "AUTHOR_REVISION_REQUESTED");

  await assert.rejects(rl.submitAuthorRevision(m.id, { id: ids.editor }, "https://f/new.docx"), /Only the author/);
  const r = await rl.submitAuthorRevision(m.id, { id: au.id }, "https://f/new.docx", "fixed");
  assert.equal(r.round, 2);
  assert.equal(r.reReviewers, 1);
  assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_PEER_REVIEW");
  const round2 = await prisma.review.findFirst({ where: { submission_id: sub.id, review_round: 2 } });
  assert.equal(round2.reviewer_id, r1.id);
  assert.equal((await prisma.article.findUnique({ where: { id: sub.article.id } })).manuscript_file_url, "https://f/new.docx");
  await assert.rejects(rl.submitAuthorRevision(m.id, { id: au.id }, "https://f/x.docx"), /Not awaiting/);
});

test("all reviewers declining alerts editors; wallet withdrawals are atomic and refundable", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  const wd = await import("../src/modules/ijsds2/withdrawals.service.js");
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const r1 = await mkP(`dc1-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const au = await mkP(`dca-${RUN}@t.io`);
  const sub = await svc.sub.createSubmission({ title: "DC", abstract: "d".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "APC_PAID" } });
  const [review] = await svc.match.assignReviewers(m.id, [r1.id], ids.editor);
  const before = await prisma.notification.count({ where: { user_id: ids.editor, title: "All reviewers declined" } });
  await rv.updateReview(review.id, { invitation_status: "declined" }, { id: r1.id, role: "reviewer" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await prisma.notification.count({ where: { user_id: ids.editor, title: "All reviewers declined" } }), before + 1);

  const rp = await svc.ms.getOrCreateReviewerProfile(r1.id);
  await prisma.reviewerProfile.update({ where: { id: rp.id }, data: { wallet_balance_naira: 3000 } });
  const bank = { bank_name: "GTBank", account_number: "0123456789", account_name: "R One" };
  await assert.rejects(wd.requestWithdrawal(r1.id, { amount: 500, ...bank }), /Minimum/);
  await assert.rejects(wd.requestWithdrawal(r1.id, { amount: 2000, ...bank, account_number: "123" }), /NUBAN/);
  const results = await Promise.allSettled([wd.requestWithdrawal(r1.id, { amount: 2000, ...bank }), wd.requestWithdrawal(r1.id, { amount: 2000, ...bank })]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "only one of two concurrent 2,000 requests fits in 3,000");
  const bal = async () => Number((await prisma.reviewerProfile.findUnique({ where: { id: rp.id } })).wallet_balance_naira);
  assert.equal(await bal(), 1000);
  const req = (await wd.listMyWithdrawals(r1.id))[0];
  await assert.rejects(wd.processWithdrawal(req.id, { outcome: "REJECTED" }, { id: ids.editor }), /note/);
  await wd.processWithdrawal(req.id, { outcome: "REJECTED", note: "bank details wrong" }, { id: ids.editor });
  assert.equal(await bal(), 3000);
  await assert.rejects(wd.processWithdrawal(req.id, { outcome: "PAID" }, { id: ids.editor }), /already processed/);
});

test("HTTP adapters validate vendor responses strictly; embeddings enable the pgvector path", T, async () => {
  const realFetch = globalThis.fetch;
  const { getPlagiarismAdapter, getAiAdapter } = await import("../src/modules/ijsds2/adapters/index.js");
  process.env.PLAGIARISM_PROVIDER = "http"; process.env.PLAGIARISM_API_URL = "https://vendor.test/p";
  process.env.AI_DETECTION_PROVIDER = "http"; process.env.AI_DETECTION_API_URL = "https://vendor.test/a";
  const reply = (body, status = 200) => async (url, o) => (String(url).startsWith("https://vendor.test") ? { ok: status < 400, status, json: async () => body } : realFetch(url, o));
  try {
    globalThis.fetch = reply({ score: 7 });
    await assert.rejects(getPlagiarismAdapter().check({ fullText: "x", title: "t" }), /outside \[0,1\]/);
    globalThis.fetch = reply({ score: 0.08, requestId: "r1", matches: [] });
    assert.equal((await getPlagiarismAdapter().check({ fullText: "x", title: "t" })).score, 0.08);
    globalThis.fetch = reply({ score: 0.2 });
    await assert.rejects(getAiAdapter().score({ fullText: "x", title: "t" }), /modelVersion/);
    globalThis.fetch = reply({}, 503);
    await assert.rejects(getAiAdapter().score({ fullText: "x", title: "t" }), /HTTP 503/);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["PLAGIARISM_PROVIDER", "PLAGIARISM_API_URL", "AI_DETECTION_PROVIDER", "AI_DETECTION_API_URL"]) delete process.env[k];
  }

  // Embeddings: vectors get filled lazily and matching switches to the vector path.
  process.env.EMBEDDINGS_API_URL = "https://embed.test/v1";
  const vec = (seed) => Array.from({ length: 1536 }, (_, i) => (i === seed ? 1 : 0));
  globalThis.fetch = async (url, o) => {
    if (!String(url).startsWith("https://embed.test")) return realFetch(url, o);
    const input = JSON.parse(o.body).input;
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vec(/welfare|social/i.test(input) ? 1 : 2) }] }) };
  };
  try {
    const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
    const au = await mkP(`vec-a-${RUN}@t.io`);
    const near = await mkP(`vec-n-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
    const far = await mkP(`vec-f-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
    const pn = await svc.ms.getOrCreateReviewerProfile(near.id);
    const pf = await svc.ms.getOrCreateReviewerProfile(far.id);
    await prisma.reviewerProfile.update({ where: { id: pn.id }, data: { expertise_keywords: ["social welfare"] } });
    await prisma.reviewerProfile.update({ where: { id: pf.id }, data: { expertise_keywords: ["astrophysics"] } });
    const sub = await svc.sub.createSubmission({ title: "Social welfare study", abstract: "welfare ".repeat(15), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
    const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
    const r = await svc.match.matchReviewers(m.id, 500);
    assert.equal(r.method, "vector");
    const rank = r.candidates.map((c) => c.userId);
    assert.ok(rank.indexOf(near.id) !== -1 && rank.indexOf(near.id) < rank.indexOf(far.id), "closer expertise ranks first");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.EMBEDDINGS_API_URL;
  }
});
