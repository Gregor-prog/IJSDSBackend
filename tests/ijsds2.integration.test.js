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
  process.env.IJSDS2_ENFORCE_PAYMENT_GATES = "true"; // most tests check the gated workflow
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

test("Gate 2: two-account split (9,500 JM / 16,000 Parakletus), referral ₦1,000 credited exactly once, state APC_PAID", T, async () => {
  paystack[R("G2")] = tx(R("G2"), 25991);
  await assert.rejects(svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_1", manuscriptId: ids.ms, payerUserId: ids.author }), /./); // wrong gate
  const r = await svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_2", manuscriptId: ids.ms, payerUserId: ids.author });
  assert.equal(r.referralCredited, true);
  await svc.pay.settlePayment({ reference: R("G2"), gate: "GATE_2", manuscriptId: ids.ms, payerUserId: ids.author }); // replay
  const d = await prisma.gate2DistributionLedger.findMany({ where: { manuscript_id: ids.ms } });
  assert.equal(d.length, 1);
  assert.equal(Number(d[0].journal_manager_naira), 9500);
  assert.equal(Number(d[0].parakletus_naira), 16000);
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
  await assert.rejects(prisma.$transaction((db) => syncManuscriptWithArticleStatus(db, sub.article.id, "accepted")), /Gate 2 publication fee/);

  await prisma.$transaction(async (db) => {
    for (const s of ["accepted", "processed", "ready_for_publication"]) await syncManuscriptWithArticleStatus(db, ids.article, s);
  });
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "READY_FOR_RELEASE");
  assert.ok(m.target_publication_year && m.target_publication_month);
});

test("monthly batch: skips papers without a registered DOI (never fabricates one), publishes those with one, leaves others to roll over", T, async () => {
  let r = await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 });
  assert.ok(!r.publishedManuscriptIds.includes(ids.ms), "paper without a DOI is not published");
  assert.ok(r.skipped.some((s) => s.manuscriptId === ids.ms && /DOI/.test(s.reason)));
  assert.equal((await prisma.manuscript.findUnique({ where: { id: ids.ms } })).doi, null);

  await prisma.article.update({ where: { id: ids.article }, data: { crossrefDoi: `10.62154/ijsds.2.10.${RUN}`, crossref_registered_at: new Date() } });
  r = await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 });
  assert.ok(r.publishedManuscriptIds.includes(ids.ms));
  const m = await prisma.manuscript.findUnique({ where: { id: ids.ms } });
  assert.equal(m.current_state, "PUBLISHED");
  assert.equal(m.doi, `10.62154/ijsds.2.10.${RUN}`);
  const art = await prisma.article.findUnique({ where: { id: ids.article } });
  assert.equal(art.status, "published");
  assert.equal(art.volume, 2);
  assert.equal(art.issue, 10);
  assert.ok(r.rolledOverCount >= 1);
  // republishing is a no-op
  assert.ok(!(await svc.batch.executeMonthlyBatch({ year: 2026, month: 10 })).publishedManuscriptIds.includes(ids.ms));
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
  const parts = [d.journal_manager_naira, d.parakletus_naira].map(Number);
  assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100), 4_318_418, "parts sum to exactly what was collected");
  assert.equal(parts[0], 16088.22); // 9,500/25,500 of 43,184.18
  // the DB itself refuses a split that doesn't match the payment
  await assert.rejects(prisma.gate2DistributionLedger.create({ data: { manuscript_id: m.id, payment_ledger_id: (await prisma.paymentLedger.findFirst({ where: { manuscript_id: m.id, payment_type: "APC" } })).id, journal_manager_naira: 1, parakletus_naira: 1 } }), /must equal the linked payment/);
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

test("open similarity provider: local archive, CORE (verified), OpenAlex abstract flag, fail-closed, audit routing", T, async () => {
  const crypto = await import("node:crypto");
  const fp = await import("../src/modules/ijsds2/similarity/fingerprints.service.js");
  const { getPlagiarismAdapter } = await import("../src/modules/ijsds2/adapters/index.js");
  const realFetch = globalThis.fetch;
  // Seeded random words, unique per run (fingerprints persist in a reused test DB).
  const rnd = (seed, n) => { let x = seed >>> 0; return Array.from({ length: n }, () => `r${((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 8) % 40009}`).join(" "); };
  const shared = rnd(RUN, 900);
  const other = rnd(RUN + 1, 900);
  const publishedId = crypto.randomUUID();
  const strangerMs = crypto.randomUUID();

  process.env.PLAGIARISM_PROVIDER = "open";
  try {
    await fp.indexDocument({ kind: "PUBLISHED", articleId: publishedId, title: "Published Alpha Study", text: shared });
    await fp.indexDocument({ kind: "SUBMISSION", manuscriptId: strangerMs, title: "SECRET UNPUBLISHED TITLE", text: shared });

    // 1) local only: finds both, hides the unpublished title, excludes own manuscript
    process.env.PLAGIARISM_OPEN_SOURCES = "local";
    const own = crypto.randomUUID();
    let r = await getPlagiarismAdapter().check({ fullText: shared, title: "t", manuscriptId: own, abstract: "" });
    assert.ok(r.score > 0.95, `identical text should be ~fully covered (got ${r.score})`);
    const titles = r.matches.map((m) => m.source_title);
    assert.ok(titles.includes("Published Alpha Study"));
    assert.ok(!JSON.stringify(r).includes("SECRET UNPUBLISHED TITLE"), "unpublished titles never leak");
    assert.ok(titles.includes("Another (unpublished) IJSDS submission"));
    assert.match(r.provider, /partial coverage/);
    r = await getPlagiarismAdapter().check({ fullText: shared, title: "t", manuscriptId: strangerMs, abstract: "" });
    assert.equal(r.matches.filter((m) => m.source_title === "Another (unpublished) IJSDS submission").length, 0, "own earlier revision excluded");
    r = await getPlagiarismAdapter().check({ fullText: other, title: "t", manuscriptId: own, abstract: "" });
    assert.ok(r.score < 0.05, `unrelated text is clean (got ${r.score})`);

    // 2) CORE: a search hit only counts when the returned full text really overlaps
    process.env.PLAGIARISM_OPEN_SOURCES = "core";
    process.env.PLAGIARISM_CORE_QUERIES = "2";
    const coreHits = [{ id: "c1", title: "Real overlapping OA paper", doi: "10.9/oa1", fullText: shared }, { id: "c2", title: "Keyword-only hit", fullText: other }];
    globalThis.fetch = async (u, o) => (String(u).includes("api.core.ac.uk") ? { ok: true, status: 200, json: async () => ({ results: coreHits }) } : realFetch(u, o));
    const slow = Date.now();
    r = await getPlagiarismAdapter().check({ fullText: shared, title: "t", manuscriptId: own, abstract: "" });
    assert.ok(Date.now() - slow >= 2000, "CORE requests are throttled to its free-tier rate");
    assert.ok(r.score > 0.95);
    assert.ok(r.matches.some((m) => m.source_title === "Real overlapping OA paper" && m.source_url === "https://doi.org/10.9/oa1"));
    assert.ok(!r.matches.some((m) => m.source_title === "Keyword-only hit"), "unverified search hit is not counted");
    globalThis.fetch = async (u, o) => (String(u).includes("api.core.ac.uk") ? { ok: false, status: 429, json: async () => ({}) } : realFetch(u, o));
    // CORE is best effort: an outage is recorded in the report, the check still completes
    r = await getPlagiarismAdapter().check({ fullText: shared, title: "t", manuscriptId: own, abstract: "" });
    assert.match(r.coverage.sources.core.unavailable, /rate limited/);
    assert.ok(r.flags.includes("CORE_UNAVAILABLE"));

    // 3) OpenAlex abstract duplicate -> flag
    process.env.PLAGIARISM_OPEN_SOURCES = "openalex";
    const abstract = rnd(RUN + 2, 60);
    const inv = {}; abstract.split(" ").forEach((w, i) => (inv[w] ??= []).push(i));
    globalThis.fetch = async (u, o) => (String(u).includes("api.openalex.org/works?search") ? { ok: true, status: 200, json: async () => ({ results: [{ id: "https://openalex.org/W5", doi: "https://doi.org/10.1/dup", title: "Already published", publication_year: 2022, abstract_inverted_index: inv }] }) } : realFetch(u, o));
    r = await getPlagiarismAdapter().check({ fullText: other, title: "My paper", manuscriptId: own, abstract });
    assert.deepEqual(r.flags, ["ABSTRACT_NEAR_DUPLICATE"]);

    // 4) through a real audit: heavy overlap with the archive => MANUAL_REVIEW (never auto-reject/auto-clear)
    process.env.PLAGIARISM_OPEN_SOURCES = "local";
    process.env.AI_DETECTION_PROVIDER = "heuristic-dev"; process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
    globalThis.fetch = realFetch;
    const mkP = (e) => prisma.profile.create({ data: { email: e, full_name: e } });
    const au = await mkP(`open-${RUN}@t.io`);
    const sub = await svc.sub.createSubmission({ title: "Copied study", abstract: "z".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, "https://f/x.docx");
    const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
    await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "SUBMITTED" } });
    await prisma.$transaction((db) => svc.audit.scheduleAuditTx(db, { ...m, current_state: "SUBMITTED" }, {}));
    await prisma.manuscript.update({ where: { id: m.id }, data: { audit_scheduled_for: new Date(Date.now() - 1000) } });
    DOC = `${shared}\n\nEthical approval was obtained from the institutional review board; participants gave informed consent.\n\nReferences\n[1] Okafor, C. (2020). Poverty and welfare in Lagos. Journal of Social Work. doi:10.1234/okafor.2020\n[2] Adeyemi, T. (2019). Community care models in Nigeria. African Social Review.\n`;
    const out = await svc.audit.runIntegrityAudit({ manuscriptId: m.id, revisionNo: 1 });
    assert.equal(out.outcome, "MANUAL_REVIEW");
    const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: m.id } });
    assert.ok(a.policy_rules_hit.includes("RULE_PLAGIARISM_CRITICAL_OVERLAP"));
    assert.equal(a.plagiarism_risk, "CRITICAL");
    assert.ok(a.evidence_payload.plagiarism_coverage?.sources?.local);
    assert.ok(a.evidence_payload.plagiarism_matches.length >= 1);
    assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_AUDIT");
    await new Promise((r2) => setTimeout(r2, 400));
    assert.ok(await prisma.documentFingerprint.findUnique({ where: { manuscript_id: m.id } }), "audited manuscript is fingerprinted for future checks");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["PLAGIARISM_PROVIDER", "PLAGIARISM_OPEN_SOURCES", "PLAGIARISM_CORE_QUERIES", "AI_DETECTION_PROVIDER"]) delete process.env[k];
    process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
  }
});

test("Stage 6 -> release: a registered DOI queues the paper for the batch; sweeper recovers backfilled and due work", T, async () => {
  const q = await import("../src/modules/ijsds2/ijsds2.queue.js");
  const mkP = (e) => prisma.profile.create({ data: { email: e, full_name: e } });
  const au = await mkP(`s6-${RUN}@t.io`);
  const mk = async (title) => {
    const sub = await svc.sub.createSubmission({ title, abstract: "s".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
    return { sub, m: await prisma.manuscript.findUnique({ where: { submission_id: sub.id } }) };
  };

  // in production, no DOI yet -> not promoted; with DOI -> promoted with a target cycle
  const p1 = await mk("S6 no doi");
  const p2 = await mk("S6 with doi");
  await prisma.manuscript.updateMany({ where: { id: { in: [p1.m.id, p2.m.id] } }, data: { current_state: "IN_PRODUCTION" } });
  await prisma.article.update({ where: { id: p2.sub.article.id }, data: { crossrefDoi: `10.62154/s6.${RUN}`, crossref_registered_at: new Date() } });
  await svc.ms.promoteReadyForRelease({ articleId: p1.sub.article.id });
  assert.equal((await prisma.manuscript.findUnique({ where: { id: p1.m.id } })).current_state, "IN_PRODUCTION");
  await svc.ms.promoteReadyForRelease(); // full sweep
  const m2 = await prisma.manuscript.findUnique({ where: { id: p2.m.id } });
  assert.equal(m2.current_state, "READY_FOR_RELEASE");
  assert.ok(m2.target_publication_year && m2.target_publication_month);

  // sweeper: a Gate-1-paid legacy SUBMITTED manuscript enters the audit pipeline; stale RUNNING resets
  const p3 = await mk("S6 legacy submitted");
  await prisma.manuscript.update({ where: { id: p3.m.id }, data: { current_state: "SUBMITTED" } });
  const p4 = await mk("S6 stale running");
  await prisma.manuscript.update({ where: { id: p4.m.id }, data: { current_state: "IN_AUDIT", audit_revision_count: 1, audit_scheduled_for: new Date(Date.now() - 5000) } });
  const stale = await prisma.manuscriptIntegrityAudit.create({ data: { manuscript_id: p4.m.id, revision_no: 1, status: "RUNNING", started_at: new Date(Date.now() - 60 * 60 * 1000) } });
  await q.sweepDueAudits();
  assert.equal((await prisma.manuscript.findUnique({ where: { id: p3.m.id } })).current_state, "IN_AUDIT");
  assert.equal(await prisma.manuscriptIntegrityAudit.count({ where: { manuscript_id: p3.m.id, status: "QUEUED" } }), 1);
  // stale RUNNING is reset and, being overdue, picked straight back up by the sweep (it is no longer stuck)
  assert.notEqual((await prisma.manuscriptIntegrityAudit.findUnique({ where: { id: stale.id } })).status, "RUNNING");
});

test("declaration mode end-to-end: no detector runs, missing disclosure -> free revision, declared paper passes, report is honest", T, async () => {
  process.env.AI_DETECTION_PROVIDER = "declaration";
  process.env.INTEGRITY_ALLOW_HEURISTIC = "true"; // plagiarism side stays the dev stand-in here
  delete process.env.PLAGIARISM_PROVIDER;
  try {
    const au = await prisma.profile.create({ data: { email: `decl-${RUN}@t.io`, full_name: "decl" } });
    const audit = async (title, doc) => {
      const sub = await svc.sub.createSubmission({ title, abstract: "d".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, "https://f/x.docx");
      const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
      await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "SUBMITTED" } });
      await prisma.$transaction((db) => svc.audit.scheduleAuditTx(db, { ...m, current_state: "SUBMITTED" }, {}));
      await prisma.manuscript.update({ where: { id: m.id }, data: { audit_scheduled_for: new Date(Date.now() - 1000) } });
      DOC = doc;
      const out = await svc.audit.runIntegrityAudit({ manuscriptId: m.id, revisionNo: 1 });
      const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: m.id } });
      return { out, a, m };
    };

    const missing = await audit("Decl missing", BODY_OK);
    assert.equal(missing.out.outcome, "AUDIT_REVISION_REQUESTED");
    assert.ok(missing.a.policy_rules_hit.includes("RULE_MISSING_AI_DISCLOSURE"));
    assert.equal(missing.a.ai_risk_band, "NOT_RUN");
    assert.equal(missing.a.ai_risk_score, null, "nothing measured, so no score is stored");
    assert.equal(missing.a.ai_detector_provider, "author-declaration");
    assert.equal(missing.a.evidence_payload.ai_detection_mode, "declaration");

    const withStatement = BODY_OK.replace("\n\nReferences", "\n\nAI use statement: No generative AI tools were used in preparing this manuscript.\n\nReferences");
    const declared = await audit("Decl present", withStatement);
    assert.equal(declared.out.outcome, "AUDIT_PASSED_PENDING_APC");
    assert.equal((await prisma.manuscript.findUnique({ where: { id: declared.m.id } })).current_state, "AUDIT_PASSED_PENDING_APC");

    const report = await svc.audit.buildAuthorReport(declared.a.id, { staff: false });
    assert.equal(report.aiAuthorship.riskBand, "NOT_RUN");
    assert.equal(report.aiAuthorship.mode, "declaration");
    assert.equal(report.aiAuthorship.hasDisclosure, true);
    assert.match(report.aiAuthorship.disclaimer, /does not use automated AI-authorship detectors/);
    assert.equal("score" in report.aiAuthorship, false);
  } finally {
    delete process.env.AI_DETECTION_PROVIDER;
    process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
  }
});

test("manual invite path enforces the same COPE firewall and stage gate as automated assignment", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const au = await mkP(`mi-a-${RUN}@t.io`);
  const referrer = await mkP(`mi-r-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const other = await mkP(`mi-o-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const rp = await svc.ms.getOrCreateReviewerProfile(referrer.id);
  const sub = await svc.sub.createSubmission({ title: "MI", abstract: "m".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io", referral_code: rp.referral_code }, au.id, null);
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });

  // before the audit/Gate 2: nobody can be invited
  await assert.rejects(rv.inviteReviewer({ submission_id: sub.id, reviewer_id: other.id }), /after the audit is cleared and the Gate 2 publication fee \(APC\) is paid\. This paper is: awaiting the Gate 1 evaluation \(vetting\) fee/);

  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "APC_PAID" } });
  await assert.rejects(rv.inviteReviewer({ submission_id: sub.id, reviewer_id: referrer.id }), /referring reviewer/);
  await assert.rejects(rv.inviteReviewer({ submission_id: sub.id, reviewer_id: au.id }), /own manuscript/);
  const ok = await rv.inviteReviewer({ submission_id: sub.id, reviewer_id: other.id });
  assert.equal(ok.reviewer_id, other.id);
});

test("paid flags are the record of payment: the workflow state follows them from every entry point", T, async () => {
  const rec = await import("../src/modules/ijsds2/flagReconciliation.service.js");
  const subs = await import("../src/modules/submissions/submissions.service.js");
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const editor = await mkP(`fl-ed-${RUN}@t.io`, { is_editor: true, role: "editor" });
  const au = await mkP(`fl-au-${RUN}@t.io`);
  const refUser = await mkP(`fl-rf-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const rp = await svc.ms.getOrCreateReviewerProfile(refUser.id);
  const mk = async (title, code) => {
    const sub = await svc.sub.createSubmission({ title, abstract: "f".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io", referral_code: code }, au.id, null);
    return { sub, m: await prisma.manuscript.findUnique({ where: { submission_id: sub.id } }) };
  };
  const state = async (id) => (await prisma.manuscript.findUnique({ where: { id } })).current_state;

  // 1) the Test V2 case: vetting flag says paid, state still waiting -> reconcile moves it and schedules the audit
  const a = await mk("FL vetting paid", rp.referral_code);
  await prisma.article.update({ where: { id: a.sub.article.id }, data: { vetting_fee: true } });
  assert.equal(await state(a.m.id), "DRAFT_PENDING_FEE1");
  assert.deepEqual(await rec.reconcileFromFlags(a.m.id), ["GATE_1"]);
  assert.equal(await state(a.m.id), "IN_AUDIT");
  assert.equal(await prisma.manuscriptIntegrityAudit.count({ where: { manuscript_id: a.m.id, status: "QUEUED" } }), 1);
  assert.deepEqual(await rec.reconcileFromFlags(a.m.id), [], "idempotent");
  const log = await prisma.workflowAuditLog.findFirst({ where: { submission_id: a.sub.id, new_status: "SUBMITTED" } });
  assert.equal(log.metadata.source, "fee-flag");
  assert.equal(await prisma.paymentLedger.count({ where: { manuscript_id: a.m.id, payment_type: "EVALUATION_FEE", status: "success" } }), 1);

  // 2) publication flag paid while the audit is cleared -> APC_PAID with the two-account split + one referral credit
  await prisma.manuscript.update({ where: { id: a.m.id }, data: { current_state: "AUDIT_PASSED_PENDING_APC" } });
  await prisma.article.update({ where: { id: a.sub.article.id }, data: { processing_fee: true } });
  assert.deepEqual(await rec.reconcileFromFlags(a.m.id), ["GATE_2"]);
  assert.equal(await state(a.m.id), "APC_PAID");
  const d = await prisma.gate2DistributionLedger.findFirst({ where: { manuscript_id: a.m.id } });
  assert.equal(Number(d.journal_manager_naira), 9500);
  assert.equal(Number(d.parakletus_naira), 16000);
  assert.equal(await prisma.referralPayoutLedger.count({ where: { manuscript_id: a.m.id } }), 1);
  await rec.reconcileFromFlags(a.m.id);
  assert.equal(await prisma.referralPayoutLedger.count({ where: { manuscript_id: a.m.id } }), 1, "referral credited once");

  // 3) an editor ticking the flag through the legacy submission API moves the workflow too
  const b = await mk("FL editor flag");
  await subs.updateSubmission(b.sub.id, { vetting_fee: true }, { userId: editor.id, role: "editor" });
  assert.equal(await state(b.m.id), "IN_AUDIT");

  // 4) the periodic sweep finds and fixes drifted rows
  const c = await mk("FL sweep");
  await prisma.article.update({ where: { id: c.sub.article.id }, data: { vetting_fee: true } });
  assert.ok((await rec.reconcileAllFromFlags()) >= 1);
  assert.equal(await state(c.m.id), "IN_AUDIT");

  // 5) legacy editorial status changes honour the flags (accepted needs Gate 2 flag + cleared audit)
  const dpaper = await mk("FL gated");
  await prisma.article.update({ where: { id: dpaper.sub.article.id }, data: { vetting_fee: true, processing_fee: true } });
  await rec.reconcileFromFlags(dpaper.m.id); // Gate 1 -> IN_AUDIT; Gate 2 can't apply until the audit clears
  assert.equal(await state(dpaper.m.id), "IN_AUDIT");
  await prisma.manuscriptIntegrityAudit.updateMany({ where: { manuscript_id: dpaper.m.id }, data: { status: "MANUAL_REVIEW" } });
  const audit = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: dpaper.m.id, status: "MANUAL_REVIEW" } });
  await svc.audit.resolveAudit(audit.id, { outcome: "AUDIT_PASSED_PENDING_APC", reason: "Editor verified originality manually" }, { id: editor.id });
  assert.equal(await state(dpaper.m.id), "APC_PAID", "a cleared audit goes straight to APC_PAID when the publication fee is already recorded as paid");
});

test("sweep runs a due audit directly when the Redis queue doesn't accept it (production 'enqueue timed out')", T, async () => {
  const q = await import("../src/modules/ijsds2/ijsds2.queue.js");
  process.env.AI_DETECTION_PROVIDER = "declaration";
  try {
    const au = await prisma.profile.create({ data: { email: `sw-${RUN}@t.io`, full_name: "sw" } });
    const sub = await svc.sub.createSubmission({ title: "Sweep inline", abstract: "s".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, "https://f/x.docx");
    const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
    await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "SUBMITTED" } });
    await prisma.$transaction((db) => svc.audit.scheduleAuditTx(db, { ...m, current_state: "SUBMITTED" }, {}));
    // the editor pulled the time forward, exactly as done in production
    await prisma.manuscript.update({ where: { id: m.id }, data: { audit_scheduled_for: new Date(Date.now() - 60_000) } });
    DOC = BODY_OK.replace("\n\nReferences", "\n\nAI use statement: No generative AI tools were used.\n\nReferences");

    // REDIS_URL points at a closed port in this test run, so enqueue times out like production did.
    const r = await q.sweepDueAudits();
    assert.ok(r.inline >= 1, "fell back to running the audit directly");
    const a = await prisma.manuscriptIntegrityAudit.findFirst({ where: { manuscript_id: m.id } });
    assert.equal(a.status, "COMPLETED");
    assert.equal(a.decision, "AUDIT_PASSED_PENDING_APC");
    assert.ok(a.started_at && a.completed_at);
    assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "AUDIT_PASSED_PENDING_APC");
  } finally {
    delete process.env.AI_DETECTION_PROVIDER;
  }
});

test("review fixes: submissions/file/delete authorization, double-blind redaction, DOI reservation, ORCID matching, email escaping", T, async () => {
  const subsSvc = await import("../src/modules/submissions/submissions.service.js");
  const filesSvc = await import("../src/modules/files/files.service.js");
  const artSvc = await import("../src/modules/articles/articles.service.js");
  const orcid = await import("../src/modules/orcid/orcid.service.js");
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const au = await mkP(`rv-au-${RUN}@t.io`);
  const rev = await mkP(`rv-rv-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const flagEd = await mkP(`rv-fe-${RUN}@t.io`, { is_editor: true, role: "author" });
  const sub = await svc.sub.createSubmission({ title: "RV", abstract: "r".repeat(80), authors: [{ name: "Ada Obi" }], corresponding_author_email: "ada@t.io" }, au.id, null);

  // a reviewer can no longer change status/fees through PATCH /api/submissions/:id
  await assert.rejects(subsSvc.updateSubmission(sub.id, { status: "accepted", vetting_fee: true }, { userId: rev.id, role: "reviewer", staff: false }), /Forbidden/);
  assert.equal((await prisma.article.findUnique({ where: { id: sub.article.id } })).vetting_fee, false);
  // a flag-only editor (role "author") can
  await subsSvc.updateSubmission(sub.id, { editor_notes: "ok" }, { userId: flagEd.id, role: "author", staff: true });

  // double-blind: reviewer sees no author identity; author sees no reviewer ids
  await prisma.review.create({ data: { submission_id: sub.id, reviewer_id: rev.id, invitation_status: "accepted" } });
  const asRev = await subsSvc.getSubmission(sub.id, { userId: rev.id, role: "reviewer", is_reviewer: true });
  assert.equal(asRev.submitter, undefined);
  assert.equal(asRev.article.authors, undefined);
  assert.equal(asRev.article.corresponding_author_email, undefined);
  const asAu = await subsSvc.getSubmission(sub.id, { userId: au.id, role: "author" });
  assert.ok(asAu.reviews.length === 1 && !("reviewer_id" in asAu.reviews[0]));

  // file upload: strangers and reviewers can't replace a manuscript; the author can
  const fakeFile = { originalname: "m.pdf", mimetype: "application/pdf", size: 3, buffer: Buffer.from("pdf") };
  await assert.rejects(filesSvc.saveFileVersion({ articleId: sub.article.id, file: fakeFile }, rev.id, { staff: false }), /own unpublished submission/);

  // author can't delete once a fee is recorded (that would cascade-delete payment ledgers)
  await prisma.article.update({ where: { id: sub.article.id }, data: { vetting_fee: true } });
  await assert.rejects(artSvc.deleteArticle(sub.article.id, { id: au.id, role: "author" }), /recorded payment/);

  // ORCID: unverified email never links to an existing account; verified does; linked iD wins
  await assert.rejects(orcid.authenticateOrcidUser("X", [{ email: au.email, verified: false }], "0000-0001-0000-000X"), /verified/);
  const linked = await orcid.authenticateOrcidUser("Ada", [{ email: au.email.toUpperCase(), verified: true }], `0000-0001-${String(RUN).slice(-4)}-0001`);
  assert.equal(linked.profile.id, au.id);
  const again = await orcid.authenticateOrcidUser("Ada", [], `0000-0001-${String(RUN).slice(-4)}-0001`);
  assert.equal(again.profile.id, au.id, "matched by ORCID iD even without a public email");
});

test("Crossref DOI numbers are reserved atomically: concurrent registrations in one issue get distinct DOIs", T, async () => {
  const cross = await import("../src/modules/crossRefDoi/cross.service.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes("crossref.org/servlet/deposit") ? { ok: true, status: 200, text: async () => "<html>Your batch submission was successfully received (SUCCESS)</html>" } : realFetch(u, o));
  try {
    const vol = 900 + (RUN % 90), issue = 7;
    const mk = (t) => prisma.article.create({ data: { title: t, abstract: "a", keywords: [], authors: [{ name: "Ada Obi" }], corresponding_author_email: "a@t.io", volume: vol, issue } });
    const arts = await Promise.all([mk("D1"), mk("D2"), mk("D3")]);
    const results = await Promise.allSettled(arts.map((a) => cross.registerDoi({ articleId: a.id })));
    const dois = (await prisma.article.findMany({ where: { id: { in: arts.map((a) => a.id) } }, select: { crossrefDoi: true } })).map((a) => a.crossrefDoi);
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.reason?.message)));
    assert.equal(new Set(dois).size, 3, `distinct DOIs: ${dois}`);
    // moving one away and registering a new one must not reuse a live number
    await prisma.article.update({ where: { id: arts[0].id }, data: { issue: 8 } });
    const late = await mk("D4");
    await cross.registerDoi({ articleId: late.id });
    const d4 = (await prisma.article.findUnique({ where: { id: late.id } })).crossrefDoi;
    assert.ok(!dois.slice(1).includes(d4), `${d4} must not collide with ${dois}`);
    const xml = cross.buildDepositXml({ ...arts[1], authors: [{ name: "Ada Obi", orcid: "0000-0002-1825-0097" }] }, dois[1], "b");
    assert.match(xml, /<given_name>Ada<\/given_name>\s*<surname>Obi<\/surname>/);
    assert.match(xml, /<ORCID>https:\/\/orcid.org\/0000-0002-1825-0097<\/ORCID>/);
    assert.match(xml, /3115-6932/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("profile updates: a stray `role` field never changes the role; assign_role does (admin only)", T, async () => {
  const prof = await import("../src/modules/profiles/profiles.service.js");
  const u = await prisma.profile.create({ data: { email: `pr-${RUN}@t.io`, full_name: "pr", request_editor: true } });
  const admin = await prisma.profile.create({ data: { email: `pr-ad-${RUN}@t.io`, full_name: "ad", is_admin: true, role: "admin" } });
  // exactly what the old frontend sent when an admin declined an editor request
  await prof.updateProfile(u.id, { request_editor: false, role: "admin" }, { userId: admin.id, role: "admin" });
  assert.equal((await prisma.profile.findUnique({ where: { id: u.id } })).role, "author");
  await prof.updateProfile(u.id, { is_admin: true, assign_role: "admin" }, { userId: admin.id, role: "admin" });
  assert.equal((await prisma.profile.findUnique({ where: { id: u.id } })).role, "admin");
  await assert.rejects(prof.updateProfile(u.id, { assign_role: "superuser" }, { userId: admin.id, role: "admin" }), /assign_role must be/);
  // a non-admin can't assign a role, even to themselves
  const v = await prisma.profile.create({ data: { email: `pr-v-${RUN}@t.io`, full_name: "v" } });
  await prof.updateProfile(v.id, { assign_role: "admin", role: "admin" }, { userId: v.id, role: "author" });
  assert.equal((await prisma.profile.findUnique({ where: { id: v.id } })).role, "author");
});

test("payment gates OFF: editors can send for review, invite, accept and release without fees/audit", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  process.env.IJSDS2_ENFORCE_PAYMENT_GATES = "false";
  try {
    const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
    const au = await mkP(`go-au-${RUN}@t.io`);
    const r1 = await mkP(`go-rv-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
    const sub = await svc.sub.createSubmission({ title: "Gates off", abstract: "g".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
    const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
    assert.equal(m.current_state, "DRAFT_PENDING_FEE1");

    await prisma.$transaction((db) => svc.ms.syncManuscriptWithArticleStatus(db, sub.article.id, "under_review"));
    assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_PEER_REVIEW");
    await rv.inviteReviewer({ submission_id: sub.id, reviewer_id: r1.id });
    for (const st of ["accepted", "processed", "ready_for_publication"]) {
      await prisma.$transaction((db) => svc.ms.syncManuscriptWithArticleStatus(db, sub.article.id, st));
    }
    const done = await prisma.manuscript.findUnique({ where: { id: m.id } });
    assert.equal(done.current_state, "READY_FOR_RELEASE");
    assert.ok(done.target_publication_month);
    const log = await prisma.workflowAuditLog.findFirst({ where: { submission_id: sub.id, change_reason: { contains: "payment gates off" } } });
    assert.ok(log, "the bypass is recorded in the audit trail");
  } finally {
    process.env.IJSDS2_ENFORCE_PAYMENT_GATES = "true";
  }
});

test("reviewer applications: validation, one pending at a time, decision updates the profile", T, async () => {
  const ra = await import("../src/modules/reviewer-applications/reviewer-applications.service.js");
  const prof = await import("../src/modules/profiles/profiles.service.js");
  const u = await prisma.profile.create({ data: { email: `ra-${RUN}@t.io`, full_name: "Ada Obi" } });
  const admin = await prisma.profile.create({ data: { email: `ra-ad-${RUN}@t.io`, full_name: "Ad", is_admin: true, role: "admin" } });
  const good = {
    full_name: "Dr Ada Obi",
    institutional_email: "ada.obi@unilag.edu.ng",
    orcid_id: "0000-0002-1825-0097",
    researchgate_url: "https://www.researchgate.net/profile/Ada-Obi",
    google_scholar_url: "https://scholar.google.com/citations?user=abc123",
  };
  // every field is required and checked
  for (const [k, v] of [["institutional_email", "ada@gmail.com"], ["orcid_id", "0000-0002-1825-0098"], ["researchgate_url", "https://linkedin.com/in/ada"], ["google_scholar_url", "https://scholar.evil.com/x"], ["full_name", ""]]) {
    await assert.rejects(ra.submitApplication(u.id, { ...good, [k]: v }), (e) => e.status === 400 && Boolean(e.fields?.[k]), k);
  }
  assert.equal(ra.normaliseOrcid("000000021825009X"), null);
  assert.equal(ra.normaliseOrcid("0000000218250097"), "0000-0002-1825-0097");

  // the old one-click request is closed
  await assert.rejects(prof.updateProfile(u.id, { request_reviewer: true }, { userId: u.id, role: "author" }), /application form/);

  const app = await ra.submitApplication(u.id, good);
  assert.equal(app.status, "PENDING");
  const p1 = await prisma.profile.findUnique({ where: { id: u.id } });
  assert.equal(p1.request_reviewer, true);
  assert.equal(p1.orcid_id, "0000-0002-1825-0097", "ORCID copied to the profile when empty");
  await assert.rejects(ra.submitApplication(u.id, good), /already have an application under review/);

  assert.ok((await ra.listApplications()).some((a) => a.id === app.id));
  await ra.decideApplication(app.id, { approve: false, reason: "Please add a scholar profile with publications" }, admin);
  let p2 = await prisma.profile.findUnique({ where: { id: u.id } });
  assert.equal(p2.request_reviewer, false);
  assert.equal(p2.is_reviewer, false);
  await assert.rejects(ra.decideApplication(app.id, { approve: true }, admin), /already decided/);

  const again = await ra.submitApplication(u.id, good); // allowed again after a decision
  await ra.decideApplication(again.id, { approve: true }, admin);
  p2 = await prisma.profile.findUnique({ where: { id: u.id } });
  assert.equal(p2.is_reviewer, true);
  await assert.rejects(ra.submitApplication(u.id, good), /already a reviewer/);
});

test("logout really ends the session; password reset ends every session; deleted accounts are refused", T, async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const { resolveSession } = await import("../src/middleware/auth.js");
  const auth = await import("../src/modules/auth/auth.service.js");
  process.env.JWT_SECRET ||= "test-secret";
  const u = await prisma.profile.create({ data: { email: `lo-${RUN}@t.io`, full_name: "lo" } });
  const sign = (iatOffset = 0) => jwt.sign({ id: u.id, email: u.email, role: "author", iat: Math.floor(Date.now() / 1000) + iatOffset }, process.env.JWT_SECRET, { expiresIn: "7d" });

  const t1 = sign(), t2 = sign(-5);
  assert.equal((await resolveSession(t1)).id, u.id);
  await auth.revokeToken(t1);
  await assert.rejects(resolveSession(t1), /Session ended/);
  assert.equal((await resolveSession(t2)).id, u.id, "other sessions keep working after a single logout");

  await auth.revokeAllSessions(u.id);
  await assert.rejects(resolveSession(t2), /Session ended/);
  const later = sign(5); // issued after the cut-off
  assert.equal((await resolveSession(later)).id, u.id);

  // expired revocations are purged
  await prisma.revokedToken.create({ data: { token_hash: "a".repeat(64), expires_at: new Date(Date.now() - 1000) } });
  await auth.purgeExpiredRevocations();
  assert.equal(await prisma.revokedToken.count({ where: { token_hash: "a".repeat(64) } }), 0);

  await prisma.profile.delete({ where: { id: u.id } });
  await assert.rejects(resolveSession(later), /Account not found/);
});

test("Crossref: a deposited DOI is only 'registered' after Crossref confirms it; failures are recorded", T, async () => {
  const cross = await import("../src/modules/crossRefDoi/cross.service.js");
  const realFetch = globalThis.fetch;
  const vol = 700 + (RUN % 90);
  const mk = (t) => prisma.article.create({ data: { title: t, abstract: "a", keywords: [], authors: [{ name: "Ada Obi" }], corresponding_author_email: "a@t.io", volume: vol, issue: 3 } });
  const ok = await mk("CR ok"), bad = await mk("CR bad");
  let logs = {};
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (s.includes("servlet/deposit")) return { ok: true, status: 200, text: async () => "<html>SUCCESS doi_batch_id</html>" };
    if (s.includes("submissionDownload")) {
      const id = new globalThis.URL(s).searchParams.get("doi_batch_id");
      return { ok: true, status: 200, text: async () => logs[id] ?? "<doi_batch_diagnostic status=\"queued\"></doi_batch_diagnostic>" };
    }
    if (s.includes("api.crossref.org/works/")) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return realFetch(u, o);
  };
  try {
    await cross.registerDoi({ articleId: ok.id });
    await cross.registerDoi({ articleId: bad.id });
    let a = await prisma.article.findUnique({ where: { id: ok.id } });
    assert.equal(a.crossref_status, "PENDING");
    assert.equal(a.crossref_registered_at, null, "deposit alone does not count as registered");

    await cross.checkPendingDeposits(); // still queued at Crossref
    assert.equal((await prisma.article.findUnique({ where: { id: ok.id } })).crossref_status, "PENDING");

    const okA = await prisma.article.findUnique({ where: { id: ok.id } });
    const badA = await prisma.article.findUnique({ where: { id: bad.id } });
    logs[okA.crossref_batch_id] = `<doi_batch_diagnostic status="completed"><record_diagnostic status="Success"><doi>${okA.crossrefDoi}</doi><msg>Successfully added</msg></record_diagnostic><batch_data><record_count>1</record_count><success_count>1</success_count><warning_count>0</warning_count><failure_count>0</failure_count></batch_data></doi_batch_diagnostic>`;
    logs[badA.crossref_batch_id] = `<doi_batch_diagnostic status="completed"><record_diagnostic status="Failure"><doi>${badA.crossrefDoi}</doi><msg>Record not processed because submitted version is less or equal to previously submitted version</msg></record_diagnostic><batch_data><record_count>1</record_count><success_count>0</success_count><warning_count>0</warning_count><failure_count>1</failure_count></batch_data></doi_batch_diagnostic>`;
    const r = await cross.checkPendingDeposits();
    assert.ok(r.registered >= 1 && r.failed >= 1, JSON.stringify(r));
    a = await prisma.article.findUnique({ where: { id: ok.id } });
    assert.equal(a.crossref_status, "REGISTERED");
    assert.ok(a.crossref_registered_at);
    const b = await prisma.article.findUnique({ where: { id: bad.id } });
    assert.equal(b.crossref_status, "FAILED");
    assert.equal(b.crossref_registered_at, null);
    assert.match(b.crossref_message, /submitted version/);

    // a manuscript with only a deposited (unconfirmed) DOI is not queued for release
    const au = await prisma.profile.create({ data: { email: `cr-${RUN}@t.io`, full_name: "cr" } });
    const sub = await prisma.submission.create({ data: { article_id: bad.id, submitter_id: au.id } });
    const m = await prisma.manuscript.create({ data: { submission_id: sub.id, title: "x", abstract: "y", author_id: au.id, current_state: "IN_PRODUCTION" } });
    await svc.ms.promoteReadyForRelease({ articleId: bad.id });
    assert.equal((await prisma.manuscript.findUnique({ where: { id: m.id } })).current_state, "IN_PRODUCTION");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("OAI-PMH: valid protocol responses (verbs, errors, paging, from/until, creators)", T, async () => {
  const oai = await import("../src/modules/oai/oai.service.js");
  const art = await prisma.article.create({
    data: { title: `OAI test ${RUN}`, abstract: "Abstract & more", keywords: ["welfare", "policy"], authors: [{ name: "Dr. Ada Obi" }, { name: "Femi Bello" }], corresponding_author_email: "a@t.io", status: "published", crossrefDoi: `10.67007/oai-${RUN}`, volume: 2, issue: 10, publication_date: new Date("2026-10-28") },
  });
  const id = `oai:ijsds.org:${art.id}`;

  let x = await oai.handleVerb({ verb: "Identify" });
  assert.match(x, /<Identify>/); assert.match(x, /<request verb="Identify">/);
  x = await oai.handleVerb({ verb: "GetRecord", identifier: id, metadataPrefix: "oai_dc" });
  assert.match(x, /<dc:creator>Obi, Ada<\/dc:creator>/, "one creator per author, honorific removed");
  assert.match(x, /<dc:creator>Bello, Femi<\/dc:creator>/);
  assert.match(x, /<dc:identifier>https:\/\/doi.org\/10.67007\/oai-/);
  assert.match(x, /<dc:date>2026-10-28<\/dc:date>/);
  assert.match(x, /Abstract &amp; more/);
  assert.match(x, /<dc:subject>welfare<\/dc:subject>/);
  // old-style identifier still resolves
  assert.match(await oai.handleVerb({ verb: "GetRecord", identifier: `oai:ijsds:10.67007/oai-${RUN}`, metadataPrefix: "oai_dc" }), /<GetRecord>/);

  x = await oai.handleVerb({ verb: "ListIdentifiers", metadataPrefix: "oai_dc" });
  assert.match(x, /<ListIdentifiers>/); assert.ok(x.includes(id));
  assert.match(await oai.handleVerb({ verb: "ListRecords", metadataPrefix: "oai_dc", from: "2099-01-01" }), /<error code="noRecordsMatch">/);
  assert.match(await oai.handleVerb({ verb: "ListRecords" }), /<error code="badArgument">/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", metadataPrefix: "marc" }), /cannotDisseminateFormat/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", metadataPrefix: "oai_dc", from: "2026-01-01", until: "2026-12-31T00:00:00Z" }), /badArgument/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", metadataPrefix: "oai_dc", set: "x" }), /noSetHierarchy/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", resumptionToken: "garbage" }), /badResumptionToken/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", resumptionToken: "x", metadataPrefix: "oai_dc" }), /badArgument/);
  assert.match(await oai.handleVerb({ verb: "GetRecord", identifier: "oai:ijsds.org:00000000-0000-0000-0000-000000000000", metadataPrefix: "oai_dc" }), /idDoesNotExist/);
  const bv = await oai.handleVerb({ verb: "Nope" });
  assert.match(bv, /<error code="badVerb">/); assert.match(bv, /<request>/, "badVerb must not echo arguments");
  assert.match(await oai.handleVerb({}), /badVerb/);
  assert.match(await oai.handleVerb({ verb: "ListRecords", metadataPrefix: ["oai_dc", "oai_dc"] }), /badArgument/);

  // paging: enough records for two pages
  const extra = Array.from({ length: 101 }, (_, i) => ({ title: `OAI page ${RUN}-${i}`, abstract: "a", keywords: [], authors: [{ name: "A B" }], corresponding_author_email: "a@t.io", status: "published" }));
  await prisma.article.createMany({ data: extra });
  const p1 = await oai.handleVerb({ verb: "ListIdentifiers", metadataPrefix: "oai_dc" });
  const tok = p1.match(/<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/)?.[1];
  assert.ok(tok, "first page carries a resumption token");
  const p2 = await oai.handleVerb({ verb: "ListIdentifiers", resumptionToken: tok });
  assert.match(p2, /<ListIdentifiers>/);
});

test("DOAJ article payload follows the v4 model (ISSNs, author names, landing-page fulltext, max 6 keywords)", T, async () => {
  const doaj = await import("../src/modules/doaj/doaj.service.js");
  const p = doaj.formatArticle({
    id: "11111111-1111-1111-1111-111111111111", title: "T", abstract: "A", status: "published",
    authors: [{ name: "Prof. Mina Ogbanga", affiliation: "RSU", orcid: "0000-0002-1825-0097" }, { name: "" }],
    keywords: ["a", "b", "c", "d", "e", "f", "g"], crossrefDoi: "10.67007/x", volume: 2, issue: 10, page_start: 5, page_end: 9,
    publication_date: new Date("2026-10-28"),
  });
  const ids = p.bibjson.identifier.map((i) => i.type);
  assert.deepEqual(ids, ["doi", "eissn", "pissn"]);
  assert.equal(p.bibjson.author.length, 1, "empty author names are dropped");
  assert.equal(p.bibjson.author[0].name, "Mina Ogbanga");
  assert.equal(p.bibjson.author[0].orcid_id, "https://orcid.org/0000-0002-1825-0097");
  assert.equal(p.bibjson.keywords.length, 6);
  assert.match(p.bibjson.link[0].url, /\/article\//);
  assert.deepEqual(p.bibjson.journal, { volume: "2", number: "10", start_page: "5", end_page: "9" });
  assert.equal(p.bibjson.year, "2026"); assert.equal(p.bibjson.month, "10");
});

test("early release: an editor can publish one confirmed-DOI article outside the monthly batch, with a reason", T, async () => {
  const mkP = (e) => prisma.profile.create({ data: { email: e, full_name: e } });
  const au = await mkP(`er-${RUN}@t.io`);
  const sub = await svc.sub.createSubmission({ title: "Early release", abstract: "e".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
  const m = await prisma.manuscript.findUnique({ where: { submission_id: sub.id } });
  const actor = { id: ids.editor };
  const release = (reason = "Missed the 28th by a day") => svc.batch.releaseArticleNow({ articleId: sub.article.id, actor, reason });
  const status = (code) => (e) => Boolean(e.status === code);

  await assert.rejects(release(""), status(400));
  await prisma.manuscript.update({ where: { id: m.id }, data: { current_state: "IN_PRODUCTION" } });
  await assert.rejects(release(), status(409)); // no DOI
  await prisma.article.update({ where: { id: sub.article.id }, data: { crossrefDoi: `10.62154/er.${RUN}`, crossref_status: "FAILED", crossref_message: "bad xml", volume: 2, issue: 11 } });
  await assert.rejects(release(), (e) => Boolean(e.status === 409 && /rejected/.test(e.message)));
  await prisma.article.update({ where: { id: sub.article.id }, data: { crossref_status: "REGISTERED", crossref_registered_at: new Date() } });

  const r = await release();
  assert.equal(r.published, true);
  const [ms, art] = await Promise.all([
    prisma.manuscript.findUnique({ where: { id: m.id } }),
    prisma.article.findUnique({ where: { id: sub.article.id } }),
  ]);
  assert.equal(ms.current_state, "PUBLISHED");
  assert.equal(art.status, "published");
  assert.ok(art.publication_date);
  assert.equal(art.volume, 2);
  assert.equal(art.issue, 11);
  const log = await prisma.workflowAuditLog.findFirst({ where: { submission_id: sub.id, new_status: "PUBLISHED" } });
  assert.match(log.change_reason, /^Early release: Missed the 28th/);
  assert.equal(log.changed_by, ids.editor);
  await assert.rejects(release(), status(409)); // already published
});

test("review documents: the assigned reviewer uploads, editors see it, authors never do; URLs can't be set directly", T, async () => {
  const rv = await import("../src/modules/reviews/reviews.service.js");
  const { StorageService } = await import("../src/services/storage.service.js");
  const stored = [], deleted = [];
  Object.assign(StorageService, {
    upload: async (path) => { stored.push(path); },
    getPublicUrl: (path) => `https://store.test/storage/v1/object/public/bucket/${path}`,
    delete: async (path) => { deleted.push(path); },
  });
  const mkP = (e, x = {}) => prisma.profile.create({ data: { email: e, full_name: e, ...x } });
  const au = await mkP(`rd-au-${RUN}@t.io`);
  const r1 = await mkP(`rd-r1-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const other = await mkP(`rd-r2-${RUN}@t.io`, { is_reviewer: true, role: "reviewer" });
  const sub = await svc.sub.createSubmission({ title: "Review doc", abstract: "d".repeat(80), authors: [{ name: "A" }], corresponding_author_email: "a@t.io" }, au.id, null);
  const review = await prisma.review.create({ data: { submission_id: sub.id, reviewer_id: r1.id, invitation_status: "accepted" } });
  const reviewer = { id: r1.id, role: "reviewer", is_reviewer: true };
  const file = (name) => ({ originalname: name, buffer: Buffer.from("x"), mimetype: "application/pdf" });
  const code = (c) => (e) => Boolean(e.status === c);

  await assert.rejects(rv.attachReviewFile(review.id, file("a.pdf"), { id: other.id, role: "reviewer" }), code(403));
  await assert.rejects(rv.updateReview(review.id, { review_file_url: "https://evil.test/x" }, reviewer), code(403));

  const first = await rv.attachReviewFile(review.id, file("my report (final).pdf"), reviewer);
  assert.match(first.review_file_url, /reviews\/.+my_report_final_\.pdf$/);
  const second = await rv.attachReviewFile(review.id, file("b.pdf"), reviewer); // replacing removes the old one
  assert.equal(deleted[0], stored[0]);

  await rv.updateReview(review.id, { recommendation: "accept", comments_to_author: "Good", submit: true }, reviewer);
  await assert.rejects(rv.removeReviewFile(review.id, reviewer), code(409));

  const staffView = await rv.listReviews({ submissionId: sub.id, userId: ids.editor, is_editor: true });
  assert.equal(staffView[0].review_file_url, second.review_file_url);
  const authorView = await rv.listReviews({ submissionId: sub.id, userId: au.id });
  assert.equal(authorView.length, 1);
  assert.equal(authorView[0].review_file_url, undefined);
  assert.equal((await rv.getReview(review.id, { id: au.id, role: "author" })).review_file_url, undefined);
});

test("nobody can request editor or admin access; older requests can still be cleared", T, async () => {
  const prof = await import("../src/modules/profiles/profiles.service.js");
  const u = await prisma.profile.create({ data: { email: `rr-${RUN}@t.io`, full_name: "rr", request_admin: true } });
  const self = { userId: u.id, role: "author" };
  for (const body of [{ request_editor: true }, { request_admin: true }]) {
    await assert.rejects(prof.updateProfile(u.id, body, self), (e) => Boolean(e.status === 403));
  }
  assert.equal((await prof.updateProfile(u.id, { request_admin: false }, self)).request_admin, false);
  assert.equal((await prisma.profile.findUnique({ where: { id: u.id } })).request_editor, false);
});
