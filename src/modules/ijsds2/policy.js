// Pure policy evaluator (PRD §4.B step "policy_engine.evaluate"). No I/O, so every rule
// is unit-testable and an audit decision can be reconstructed from stored evidence.
//
// Hard invariants (not configurable):
//  1. AI-authorship signal alone NEVER rejects. At most it asks for clarification or
//     routes to a human.
//  2. A failed/missing mandatory component NEVER clears a manuscript: result is
//     MANUAL_REVIEW (audit incomplete), not AUDIT_PASSED_PENDING_APC.
//  3. Plagiarism-critical is a recommendation to reject that an editor confirms.

export const OUTCOMES = Object.freeze({
  PASSED: "AUDIT_PASSED_PENDING_APC",
  REVISION: "AUDIT_REVISION_REQUESTED",
  REJECTED: "AUDIT_REJECTED",
  MANUAL: "MANUAL_REVIEW",
});

export const MANDATORY_COMPONENTS = ["structural", "plagiarism", "ai", "citations"];

export const evaluatePolicy = ({ structural, plagiarism, ai, citations, componentErrors = {} }, cfg) => {
  const rules = [];
  const actions = [];
  let requiresHumanReview = false;

  // ── Invariant 2: incomplete mandatory checks ────────────────────────────────────
  const missing = MANDATORY_COMPONENTS.filter(
    (c) => componentErrors[c] || { structural, plagiarism, ai, citations }[c] == null,
  );
  if (missing.length) {
    return {
      outcome: OUTCOMES.MANUAL,
      rules: missing.map((c) => `RULE_COMPONENT_INCOMPLETE_${c.toUpperCase()}`),
      actions: [],
      requiresHumanReview: true,
      incompleteComponents: missing,
    };
  }

  let outcome = OUTCOMES.PASSED;
  const escalate = (to) => {
    const rank = { [OUTCOMES.PASSED]: 0, [OUTCOMES.REVISION]: 1, [OUTCOMES.MANUAL]: 2, [OUTCOMES.REJECTED]: 3 };
    if (rank[to] > rank[outcome]) outcome = to;
  };

  // ── 2A structural ───────────────────────────────────────────────────────────────
  if (!structural.has_references || !structural.word_count_valid || !structural.has_abstract) {
    rules.push("RULE_STRUCTURAL_DEFICIT");
    actions.push("Core structural sections (abstract, body, references) are missing or too short.");
    if (cfg.auto_reject_structural) escalate(OUTCOMES.REJECTED);
    else {
      requiresHumanReview = true;
      escalate(OUTCOMES.MANUAL);
    }
  }
  if (!structural.has_ethics_statement) {
    rules.push("RULE_MISSING_ETHICS_DECLARATION");
    actions.push("Add an explicit ethics statement and conflict-of-interest declaration.");
    escalate(OUTCOMES.REVISION);
  }

  // ── 2B plagiarism ───────────────────────────────────────────────────────────────
  if (plagiarism.score >= cfg.plagiarism.critical) {
    rules.push("RULE_PLAGIARISM_CRITICAL_OVERLAP");
    actions.push("Textual similarity exceeds the scholarly threshold; editorial confirmation is required.");
    requiresHumanReview = true;
    escalate(OUTCOMES.MANUAL);
  } else if (plagiarism.score >= cfg.plagiarism.moderate) {
    rules.push("RULE_MODERATE_SIMILARITY");
    actions.push("Paraphrase the overlapping passages listed in the report and cite all quoted sources.");
    escalate(OUTCOMES.REVISION);
  }

  if (plagiarism.flags?.includes("ABSTRACT_NEAR_DUPLICATE")) {
    rules.push("RULE_ABSTRACT_NEAR_DUPLICATE");
    actions.push("The abstract closely matches an already-published abstract; editorial confirmation is required.");
    requiresHumanReview = true;
    escalate(OUTCOMES.MANUAL);
  }

  // ── 2C AI risk — advisory only (invariant 1) ───────────────────────────────────
  if (ai.score >= cfg.ai.high) {
    rules.push("RULE_AI_RISK_FLAG");
    actions.push("Provide an AI-use disclosure describing any generative tools used in preparing the manuscript.");
    requiresHumanReview = true;
    escalate(OUTCOMES.REVISION);
  }

  // ── 2D/2E citations ─────────────────────────────────────────────────────────────
  if (citations.orphaned_markers.length > 0) {
    rules.push("RULE_ORPHANED_CITATIONS");
    actions.push(`In-text citations with no bibliography entry: ${citations.orphaned_markers.slice(0, 5).join(", ")}.`);
    escalate(OUTCOMES.REVISION);
  }
  if (citations.uncited_indices.length > cfg.citations.max_uncited_references) {
    rules.push("RULE_UNCITED_BIBLIOGRAPHY");
    actions.push("Several bibliography entries are never cited in the text.");
    escalate(OUTCOMES.REVISION);
  }
  if (citations.total > 0 && citations.unresolved / citations.total > cfg.citations.max_unresolved_ratio) {
    rules.push("RULE_UNRESOLVED_REFERENCES");
    actions.push("Many references could not be verified against Crossref/OpenAlex. Check titles, years and DOIs.");
    escalate(OUTCOMES.REVISION);
  }
  if (citations.metadata_mismatch > 0) {
    rules.push("RULE_REFERENCE_METADATA_MISMATCH");
    actions.push("Some references disagree with the registry record (year/title). Correct them.");
    escalate(OUTCOMES.REVISION);
  }

  // Safety net for invariant 1: if the ONLY rule hit is AI, it can't be a rejection.
  if (outcome === OUTCOMES.REJECTED && rules.every((r) => r === "RULE_AI_RISK_FLAG")) {
    outcome = OUTCOMES.MANUAL;
  }

  return { outcome, rules, actions, requiresHumanReview, incompleteComponents: [] };
};

export const bandPlagiarism = (score, cfg) =>
  score >= cfg.plagiarism.critical ? "CRITICAL"
  : score >= cfg.plagiarism.high ? "HIGH"
  : score >= cfg.plagiarism.moderate ? "MODERATE"
  : "LOW";

export const bandAi = (score, cfg) =>
  score >= cfg.ai.high ? "HIGH" : score >= cfg.ai.medium ? "MEDIUM" : "LOW";
