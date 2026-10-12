import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DATABASE_URL ??= "postgresql://u:p@127.0.0.1:1/x";
process.env.PAYSTACK_SECRET_KEY_LIVE = "sk_test_unit";

const { evaluatePolicy, OUTCOMES } = await import("../src/modules/ijsds2/policy.js");
const { DEFAULT_CONFIG } = await import("../src/modules/ijsds2/integrity.config.js");
const { FINANCIALS, TRANSITIONS, computeGate2Split } = await import("../src/modules/ijsds2/ijsds2.constants.js");
const { getCycle, getBatchTarget, releaseInstant, cutoffInstant, volumeIssueFor } = await import("../src/modules/ijsds2/calendar.js");
const { extractCitations } = await import("../src/modules/ijsds2/citations.service.js");
const { verifyWebhookSignature } = await import("../src/modules/ijsds2/payments.service.js");
const { canTransition } = await import("../src/modules/ijsds2/stateMachine.js");
const { getPlagiarismAdapter, getAiAdapter } = await import("../src/modules/ijsds2/adapters/index.js");

const cfg = DEFAULT_CONFIG;
const clean = () => ({
  structural: { has_abstract: true, has_references: true, word_count_valid: true, has_ethics_statement: true },
  plagiarism: { score: 0.02 },
  ai: { score: 0.02 },
  citations: { total: 10, unresolved: 0, metadata_mismatch: 0, orphaned_markers: [], uncited_indices: [] },
});

// ── Money ───────────────────────────────────────────────────────────────────────────
test("fees match PRD: 5,000 + 25,500 = 30,500 and the two-account split sums to 25,500", () => {
  assert.equal(FINANCIALS.GATE_1_NAIRA + FINANCIALS.GATE_2_NAIRA, FINANCIALS.TOTAL_APC_NAIRA);
  assert.equal(Object.values(FINANCIALS.GATE_2_SPLIT).reduce((a, b) => a + b, 0), FINANCIALS.GATE_2_NAIRA);
  assert.equal(FINANCIALS.REFERRAL_COMMISSION_NAIRA, 1000);
});

// ── Policy ──────────────────────────────────────────────────────────────────────────
test("clean manuscript passes", () => {
  assert.equal(evaluatePolicy(clean(), cfg).outcome, OUTCOMES.PASSED);
});

test("AI signal alone never rejects — even at maximum risk", () => {
  const input = clean();
  input.ai = { score: 1 };
  const r = evaluatePolicy(input, cfg);
  assert.notEqual(r.outcome, OUTCOMES.REJECTED);
  assert.equal(r.outcome, OUTCOMES.REVISION);
  assert.ok(r.requiresHumanReview);
});

test("AI risk is never what pushes an otherwise-passing paper to rejection, for any threshold config", () => {
  for (const high of [0, 0.1, 0.5, 1]) {
    const r = evaluatePolicy({ ...clean(), ai: { score: 1 } }, { ...cfg, ai: { medium: 0, high } });
    assert.notEqual(r.outcome, OUTCOMES.REJECTED);
  }
});

test("failed or missing mandatory component never clears — routes to manual review", () => {
  for (const c of ["structural", "plagiarism", "ai", "citations"]) {
    const input = clean();
    input[c] = null;
    const r = evaluatePolicy({ ...input, componentErrors: { [c]: "timeout" } }, cfg);
    assert.equal(r.outcome, OUTCOMES.MANUAL, c);
    assert.ok(r.requiresHumanReview);
  }
  const r = evaluatePolicy({ ...clean(), componentErrors: { ai: "provider down" } }, cfg);
  assert.equal(r.outcome, OUTCOMES.MANUAL);
});

test("critical plagiarism needs editorial confirmation instead of auto-reject", () => {
  const r = evaluatePolicy({ ...clean(), plagiarism: { score: 0.4 } }, cfg);
  assert.equal(r.outcome, OUTCOMES.MANUAL);
  assert.ok(r.rules.includes("RULE_PLAGIARISM_CRITICAL_OVERLAP"));
});

test("moderate similarity, orphaned citations, missing ethics, unresolved refs -> revision", () => {
  assert.equal(evaluatePolicy({ ...clean(), plagiarism: { score: 0.12 } }, cfg).outcome, OUTCOMES.REVISION);
  const i = clean();
  i.citations.orphaned_markers = ["[44]"];
  assert.equal(evaluatePolicy(i, cfg).outcome, OUTCOMES.REVISION);
  const j = clean();
  j.structural.has_ethics_statement = false;
  assert.equal(evaluatePolicy(j, cfg).outcome, OUTCOMES.REVISION);
  const k = clean();
  k.citations.unresolved = 5;
  assert.equal(evaluatePolicy(k, cfg).outcome, OUTCOMES.REVISION);
});

test("structural failure rejects (configurable) or goes to a human", () => {
  const i = clean();
  i.structural.has_references = false;
  assert.equal(evaluatePolicy(i, cfg).outcome, OUTCOMES.REJECTED);
  assert.equal(evaluatePolicy(i, { ...cfg, auto_reject_structural: false }).outcome, OUTCOMES.MANUAL);
});

test("thresholds come from config, not constants", () => {
  const strict = { ...cfg, plagiarism: { moderate: 0.01, high: 0.02, critical: 0.03 } };
  assert.equal(evaluatePolicy({ ...clean(), plagiarism: { score: 0.02 } }, strict).outcome, OUTCOMES.REVISION);
  assert.equal(evaluatePolicy({ ...clean(), plagiarism: { score: 0.02 } }, cfg).outcome, OUTCOMES.PASSED);
});

// ── State machine ───────────────────────────────────────────────────────────────────
test("state machine: no skipping Gate 2 or the batch", () => {
  assert.ok(canTransition("IN_AUDIT", "AUDIT_PASSED_PENDING_APC"));
  assert.ok(!canTransition("AUDIT_PASSED_PENDING_APC", "IN_PEER_REVIEW"));
  assert.ok(!canTransition("IN_PRODUCTION", "PUBLISHED"));
  assert.ok(canTransition("READY_FOR_RELEASE", "PUBLISHED"));
  assert.ok(canTransition("AUDIT_REVISION_REQUESTED", "IN_AUDIT")); // free re-audit
  assert.deepEqual(TRANSITIONS.AUDIT_REJECTED, []); // needs a new draft + new fee
  assert.deepEqual(TRANSITIONS.PUBLISHED, []);
});

// ── Calendar (WAT) ──────────────────────────────────────────────────────────────────
test("release is 00:00 WAT on the 28th = 23:00 UTC on the 27th; cutoff 23:59 WAT the 27th", () => {
  assert.equal(releaseInstant(2026, 10).toISOString(), "2026-10-27T23:00:00.000Z");
  assert.equal(cutoffInstant(2026, 10).toISOString(), "2026-10-27T22:59:59.999Z");
});

test("cycle is timezone-independent and rolls over after release", () => {
  const before = getCycle(new Date("2026-10-12T10:00:00Z"));
  assert.equal(before.targetMonth, 10);
  assert.equal(before.isCutoffPassed, false);
  const afterCutoff = getCycle(new Date("2026-10-27T23:30:00Z")); // 00:30 WAT on the 28th? no: 00:30 WAT = 23:30Z -> release at 23:00Z already passed
  assert.equal(afterCutoff.targetMonth, 11);
  const betweenCutoffAndRelease = getCycle(new Date("2026-10-27T22:59:59.999Z"));
  assert.equal(betweenCutoffAndRelease.targetMonth, 10);
  assert.equal(getCycle(new Date("2026-12-28T12:00:00Z")).targetYear, 2027);
});

test("scheduled run at 00:00:00 WAT on the 28th publishes THAT month, not next", () => {
  assert.deepEqual(getBatchTarget(new Date("2026-10-27T23:00:00Z")), { year: 2026, month: 10 });
  assert.deepEqual(getBatchTarget(new Date("2026-12-27T23:00:00Z")), { year: 2026, month: 12 });
  // manual early run targets the upcoming release
  assert.deepEqual(getBatchTarget(new Date("2026-10-12T10:00:00Z")), { year: 2026, month: 10 });
});

test("volume/issue", () => assert.deepEqual(volumeIssueFor(2026, 10), { volume: 2, issue: 10 }));

// ── Citation extraction ─────────────────────────────────────────────────────────────
test("extracts references, links markers, flags orphans and uncited entries", () => {
  const body = "Poverty shapes outcomes [1]. Community care works well [2, 3]. Unknown claim [9].";
  const refs = [
    "[1] Okafor, C. (2020). Poverty and welfare in Lagos. Journal of Social Work. doi:10.1234/abcd.5678",
    "[2] Adeyemi, T. (2019). Community care models in Nigeria. African Social Review.",
    "[3] Bello, K. (2018). Never cited elsewhere. Policy Studies.",
    "[4] Uncited, U. (2017). A reference nobody cites in the text. Some Journal.",
  ].join("\n");
  const r = extractCitations({ body_text: body, references_text: refs });
  assert.equal(r.references.length, 4);
  assert.equal(r.references[0].doi, "10.1234/abcd.5678");
  assert.equal(r.references[0].title, "Poverty and welfare in Lagos");
  assert.equal(r.references[1].title, "Community care models in Nigeria");
  assert.deepEqual(r.orphaned_markers, ["[9]"]);
  assert.deepEqual(r.uncited_indices, [4]);
  assert.equal(r.references[1].contexts.length, 1);
});

// ── Webhook signature ───────────────────────────────────────────────────────────────
test("paystack webhook signature: valid accepted, tampered/missing rejected", () => {
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "r1" } }));
  const sig = crypto.createHmac("sha512", "sk_test_unit").update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, sig), true);
  assert.equal(verifyWebhookSignature(Buffer.from(body.toString() + " "), sig), false);
  assert.equal(verifyWebhookSignature(body, undefined), false);
  assert.equal(verifyWebhookSignature(body, "deadbeef"), false);
});

// ── Provider adapters fail closed ───────────────────────────────────────────────────
test("integrity providers fail closed unless explicitly configured", () => {
  delete process.env.PLAGIARISM_PROVIDER;
  delete process.env.AI_DETECTION_PROVIDER;
  delete process.env.INTEGRITY_ALLOW_HEURISTIC;
  assert.throws(() => getPlagiarismAdapter(), /No plagiarism provider configured/);
  assert.throws(() => getAiAdapter(), /No ai provider configured/);
  process.env.INTEGRITY_ALLOW_HEURISTIC = "true";
  assert.equal(getPlagiarismAdapter().constructor, Object);
  delete process.env.INTEGRITY_ALLOW_HEURISTIC;
});

test("Gate 2 split: ₦9,500 Journal Manager / ₦16,000 Parakletus; same percentage and exact for any other total", () => {
  assert.deepEqual(computeGate2Split(25500), { journal_manager_naira: 9500, parakletus_naira: 16000 });
  assert.deepEqual(computeGate2Split(43184.18), { journal_manager_naira: 16088.22, parakletus_naira: 27095.96 });
  for (const total of [43184.18, 1, 99999.99, 25991]) {
    const p = Object.values(computeGate2Split(total));
    assert.equal(Math.round(p.reduce((a, b) => a + b, 0) * 100), Math.round(total * 100), `sums exactly for ${total}`);
  }
});
