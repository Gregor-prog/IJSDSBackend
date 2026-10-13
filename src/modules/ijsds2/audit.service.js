import prisma from "../../config/prisma.js";
import { AUDIT_DELAY_HOURS, httpError } from "./ijsds2.constants.js";
import { transitionManuscript } from "./stateMachine.js";
import { getActiveConfig } from "./integrity.config.js";
import { evaluatePolicy, bandAi, bandPlagiarism, OUTCOMES } from "./policy.js";
import { getPlagiarismAdapter, getAiAdapter, ProviderNotConfiguredError } from "./adapters/index.js";
import { fetchFileBuffer, extractText, parseManuscriptText } from "./manuscriptParser.js";
import {
  extractCitations,
  resolveReference,
  scoreRelevance,
  discoverRelated,
  ProviderError,
  cacheStats,
  SCORER_VERSION,
} from "./citations.service.js";
import { indexDocument } from "./similarity/fingerprints.service.js";
import { createNotification } from "../notifications/notifications.service.js";
import { sendIntegrityAuditReportEmail } from "../email/email.service.js";

const DISCLAIMER =
  "AI-authorship detection is a risk signal, not conclusive evidence of authorship. It is never used on its own to reject a manuscript.";

// ── Scheduling (PRD §4.A) ───────────────────────────────────────────────────────────

/**
 * Moves a manuscript to IN_AUDIT and creates the versioned audit row, inside the caller's
 * transaction. The DB row (audit_scheduled_for + QUEUED audit) is the source of truth:
 * the BullMQ delayed job is just an accelerator, and the sweeper recovers it if Redis
 * loses the job. The 24h window is an SLA, not an idle wait.
 */
export const scheduleAuditTx = async (tx, manuscript, { actorId = null, reason } = {}) => {
  const revisionNo = manuscript.audit_revision_count + 1;
  const scheduledFor = new Date(Date.now() + AUDIT_DELAY_HOURS * 3600 * 1000);

  await transitionManuscript(
    tx,
    manuscript.id,
    manuscript.current_state,
    "IN_AUDIT",
    { audit_scheduled_for: scheduledFor, audit_revision_count: revisionNo },
    { changedBy: actorId, reason, metadata: { revision_no: revisionNo } },
  );
  await tx.manuscriptIntegrityAudit.create({
    data: { manuscript_id: manuscript.id, revision_no: revisionNo, status: "QUEUED" },
  });
  return { revisionNo, scheduledFor };
};

// ── Execution ───────────────────────────────────────────────────────────────────────

const structuralChecks = (parsed, abstract, cfg) => {
  const notes = [];
  const has_abstract = (abstract || "").trim().length > 50;
  const has_references = parsed.has_references_heading;
  const word_count_valid = parsed.word_count >= cfg.structure.min_word_count;
  const has_ethics_statement = /ethic(?:s|al)\s+(?:approval|statement|clearance)|informed consent|institutional review board|declaration of (?:interest|conflict)|conflicts? of interest/i.test(parsed.full_text);
  if (!has_abstract) notes.push("Abstract missing or too brief.");
  if (!has_references) notes.push("No References/Bibliography section detected.");
  if (!word_count_valid) notes.push(`Manuscript has ${parsed.word_count} words (minimum ${cfg.structure.min_word_count}).`);
  if (!has_ethics_statement) notes.push("No ethics or conflict-of-interest declaration found.");
  return { has_abstract, has_references, word_count_valid, has_ethics_statement, word_count: parsed.word_count, notes };
};

const toAuditError = (e) => `${e.name}: ${e.message}`.slice(0, 500);

/**
 * Runs Stage 2 for one audit row. Safe to call concurrently and repeatedly: the claim is a
 * compare-and-set on status, and results are written transactionally.
 *
 * Failure semantics (PRD §7 "Failure handling"):
 *  - transient provider error, attempts remaining  -> status back to QUEUED, error thrown
 *    so the queue retries
 *  - provider not configured / final attempt       -> MANUAL_REVIEW (never auto-cleared)
 */
export const runIntegrityAudit = async ({ manuscriptId, revisionNo, force = false, isFinalAttempt = true }) => {
  const manuscript = await prisma.manuscript.findUnique({ where: { id: manuscriptId } });
  if (!manuscript) throw httpError(404, "Manuscript not found");
  if (manuscript.current_state !== "IN_AUDIT") return { skipped: `state is ${manuscript.current_state}` };
  if (!force && manuscript.audit_scheduled_for && manuscript.audit_scheduled_for > new Date()) {
    return { skipped: "not due yet" };
  }

  const claimed = await prisma.manuscriptIntegrityAudit.updateMany({
    where: { manuscript_id: manuscriptId, revision_no: revisionNo, status: "QUEUED" },
    data: { status: "RUNNING", started_at: new Date(), last_error: null },
  });
  if (claimed.count !== 1) return { skipped: "already claimed or finished" };

  const audit = await prisma.manuscriptIntegrityAudit.findUnique({
    where: { manuscript_id_revision_no: { manuscript_id: manuscriptId, revision_no: revisionNo } },
  });
  const cfg = await getActiveConfig();
  const errors = {};
  let transient = false;
  const out = {};

  // Stage 1 — ingestion & parsing
  let parsed = null;
  try {
    if (!manuscript.raw_file_r2_key) throw new Error("No manuscript file on record");
    const buf = await fetchFileBuffer(manuscript.raw_file_r2_key);
    const text = await extractText(buf, manuscript.raw_file_r2_key);
    if (text.trim().length < 200) throw new Error("Extracted text is empty or too short (scanned PDF?)");
    parsed = parseManuscriptText(text);
  } catch (e) {
    errors.structural = toAuditError(e);
    if (!(e.message || "").startsWith("Unsupported") && !/No manuscript file|empty or too short/.test(e.message)) transient = true;
  }

  if (parsed) {
    out.structural = structuralChecks(parsed, manuscript.abstract, cfg);

    // 2B / 2C — data minimization: only the body text (bibliography excluded) leaves.
    const [plag, ai] = await Promise.all([
      (async () => getPlagiarismAdapter().check({ fullText: parsed.body_text, title: manuscript.title, manuscriptId, abstract: manuscript.abstract }))().catch((e) => ({ __error: e })),
      (async () => getAiAdapter().score({ fullText: parsed.body_text, title: manuscript.title }))().catch((e) => ({ __error: e })),
    ]);
    if (plag.__error) {
      errors.plagiarism = toAuditError(plag.__error);
      if (!(plag.__error instanceof ProviderNotConfiguredError)) transient = true;
    } else out.plagiarism = plag;
    if (ai.__error) {
      errors.ai = toAuditError(ai.__error);
      if (!(ai.__error instanceof ProviderNotConfiguredError)) transient = true;
    } else out.ai = ai;

    // 2D / 2E
    try {
      const extracted = extractCitations(parsed);
      const resolutions = [];
      for (const ref of extracted.references) {
        const resolution = await resolveReference(ref); // throws ProviderError on outage
        const relevance = scoreRelevance(ref, resolution, cfg);
        resolutions.push({ ref, ...resolution, relevance });
      }
      const related = await discoverRelated({ abstract: manuscript.abstract, resolutions, cfg });
      out.citations = {
        total: resolutions.length,
        unresolved: resolutions.filter((r) => r.status === "UNRESOLVED").length,
        metadata_mismatch: resolutions.filter((r) => r.status === "METADATA_MISMATCH").length,
        warnings: resolutions.filter((r) => r.relevance.codes.length > 0).length,
        orphaned_markers: extracted.orphaned_markers,
        uncited_indices: extracted.uncited_indices,
        resolutions,
        related,
      };
    } catch (e) {
      errors.citations = toAuditError(e);
      if (e instanceof ProviderError) transient = true;
    }
  }

  // Transient failure with retries left: hand back to the queue, leave no partial result.
  if (Object.keys(errors).length && transient && !isFinalAttempt) {
    await prisma.manuscriptIntegrityAudit.update({
      where: { id: audit.id },
      data: { status: "QUEUED", last_error: JSON.stringify(errors) },
    });
    throw new Error(`Audit attempt failed, will retry: ${JSON.stringify(errors)}`);
  }

  const decision = evaluatePolicy(
    { structural: out.structural, plagiarism: out.plagiarism, ai: out.ai, citations: out.citations, componentErrors: errors },
    cfg,
  );

  const citationRows = (out.citations?.resolutions ?? []).map((r) => ({
    manuscript_id: manuscriptId,
    audit_id: audit.id,
    bibliography_index: r.ref.index,
    raw_reference: r.ref.raw,
    in_text_contexts: r.ref.contexts,
    normalized_title: r.ref.title ?? r.work?.title ?? null,
    normalized_authors: r.ref.authors,
    publication_year: r.ref.year ?? null,
    supplied_doi: r.ref.doi ?? null,
    resolved_doi: r.resolvedDoi,
    crossref_work_id: r.crossrefId,
    openalex_work_id: r.openalexId,
    resolution_status: r.status,
    metadata_match_score: r.matchScore,
    semantic_relevance_score: r.relevance.score,
    warning_codes: r.relevance.codes,
  }));
  const recRows = (out.citations?.related ?? []).map((r) => ({ ...r, manuscript_id: manuscriptId, audit_id: audit.id }));

  const manual = decision.outcome === OUTCOMES.MANUAL;
  const unresolved = out.citations?.unresolved ?? 0;
  const total = out.citations?.total ?? 0;

  await prisma.$transaction(async (tx) => {
    // Idempotent if a crashed run left partial children behind.
    await tx.manuscriptCitation.deleteMany({ where: { audit_id: audit.id } });
    await tx.citationRecommendation.deleteMany({ where: { audit_id: audit.id } });
    if (citationRows.length) await tx.manuscriptCitation.createMany({ data: citationRows });
    if (recRows.length) await tx.citationRecommendation.createMany({ data: recRows });

    await tx.manuscriptIntegrityAudit.update({
      where: { id: audit.id },
      data: {
        status: manual ? "MANUAL_REVIEW" : "COMPLETED",
        decision: manual ? null : decision.outcome,
        plagiarism_score: out.plagiarism?.score ?? null,
        plagiarism_risk: out.plagiarism ? bandPlagiarism(out.plagiarism.score, cfg) : null,
        plagiarism_provider: out.plagiarism?.provider ?? null,
        ai_risk_score: out.ai?.score ?? null,
        ai_risk_band: out.ai ? bandAi(out.ai.score, cfg) : null,
        ai_detector_provider: out.ai?.provider ?? null,
        ai_detector_model_version: out.ai?.modelVersion ?? null,
        citation_validation_score: total ? Number((1 - unresolved / total).toFixed(5)) : null,
        unresolved_citation_count: unresolved,
        citation_warning_count: out.citations?.warnings ?? 0,
        requires_human_review: decision.requiresHumanReview,
        policy_rules_hit: decision.rules,
        config_revision_id: cfg.id,
        last_error: Object.keys(errors).length ? JSON.stringify(errors) : null,
        evidence_payload: {
          structural: out.structural ?? null,
          plagiarism_matches: out.plagiarism?.matches ?? [],
          plagiarism_request_id: out.plagiarism?.requestId ?? null,
          plagiarism_flags: out.plagiarism?.flags ?? [],
          plagiarism_coverage: out.plagiarism?.coverage ?? null,
          ai_flagged_segments: out.ai?.flaggedSegments ?? [],
          ai_request_id: out.ai?.requestId ?? null,
          orphaned_markers: out.citations?.orphaned_markers ?? [],
          uncited_indices: out.citations?.uncited_indices ?? [],
          required_actions: decision.actions,
          incomplete_components: decision.incompleteComponents,
          component_errors: errors,
          relevance_scorer: SCORER_VERSION,
          registry_cache: { ...cacheStats },
          manuscript_stats: parsed ? { word_count: parsed.word_count, char_count: parsed.char_count } : null,
        },
        completed_at: new Date(),
      },
    });

    if (!manual) {
      await applyDecisionTx(tx, manuscript, audit.id, decision.outcome, { reason: "Stage 2 policy evaluation", actorId: null });
    }
  });

  // Keep this manuscript's fingerprints so later submissions are compared against it.
  if (parsed) {
    indexDocument({ kind: "SUBMISSION", manuscriptId, title: manuscript.title, text: parsed.body_text }).catch((e) =>
      console.error("[ijsds2] fingerprint indexing failed:", e.message),
    );
  }

  await notifyAfterAudit(manuscript, audit.id, decision.outcome).catch((e) =>
    console.error("[ijsds2] audit notification failed:", e.message),
  );
  return { auditId: audit.id, outcome: decision.outcome };
};

// Release protection (PRD §7): PASSED only with a COMPLETED audit with no incomplete
// mandatory component, or an attributed manual override.
const applyDecisionTx = async (tx, manuscript, auditId, outcome, { reason, actorId }) => {
  if (outcome === OUTCOMES.PASSED) {
    const a = await tx.manuscriptIntegrityAudit.findUnique({ where: { id: auditId } });
    const incomplete = a.evidence_payload?.incomplete_components ?? [];
    const overridden = Boolean(a.resolved_by);
    if (a.status !== "COMPLETED" || (incomplete.length > 0 && !overridden)) {
      throw httpError(409, "Cannot clear audit: mandatory Stage 2 components incomplete and no manual override recorded");
    }
  }
  await transitionManuscript(
    tx,
    manuscript.id,
    "IN_AUDIT",
    outcome,
    { audit_completed_at: new Date() },
    { changedBy: actorId, reason, metadata: { audit_id: auditId } },
  );
};

// ── Editorial resolution of MANUAL_REVIEW audits ────────────────────────────────────

export const resolveAudit = async (auditId, { outcome, reason }, actor) => {
  if (![OUTCOMES.PASSED, OUTCOMES.REVISION, OUTCOMES.REJECTED].includes(outcome)) {
    throw httpError(400, "outcome must be AUDIT_PASSED_PENDING_APC, AUDIT_REVISION_REQUESTED or AUDIT_REJECTED");
  }
  if (!reason || reason.trim().length < 10) throw httpError(400, "A reason (min 10 chars) is required for an override");

  const audit = await prisma.manuscriptIntegrityAudit.findUnique({ where: { id: auditId }, include: { manuscript: true } });
  if (!audit) throw httpError(404, "Audit not found");
  if (!["MANUAL_REVIEW", "FAILED"].includes(audit.status)) throw httpError(409, `Audit is ${audit.status}; only MANUAL_REVIEW/FAILED audits can be resolved`);

  await prisma.$transaction(async (tx) => {
    await tx.manuscriptIntegrityAudit.update({
      where: { id: auditId },
      data: {
        status: "COMPLETED",
        decision: outcome,
        resolved_by: actor.id,
        resolved_reason: reason.trim(),
        resolved_at: new Date(),
        completed_at: audit.completed_at ?? new Date(),
      },
    });
    await applyDecisionTx(tx, audit.manuscript, auditId, outcome, { reason: `Editorial resolution: ${reason.trim()}`, actorId: actor.id });
  });

  await notifyAfterAudit(audit.manuscript, auditId, outcome).catch((e) => console.error("[ijsds2] notify failed:", e.message));
  return { auditId, outcome };
};

/** Re-queues a FAILED/MANUAL_REVIEW audit (e.g. after a provider is configured). */
export const requeueAudit = async (auditId) => {
  const audit = await prisma.manuscriptIntegrityAudit.findUnique({ where: { id: auditId }, include: { manuscript: true } });
  if (!audit) throw httpError(404, "Audit not found");
  if (!["MANUAL_REVIEW", "FAILED"].includes(audit.status) || audit.manuscript.current_state !== "IN_AUDIT") {
    throw httpError(409, "Only unresolved audits of manuscripts still IN_AUDIT can be re-queued");
  }
  await prisma.manuscriptIntegrityAudit.update({ where: { id: auditId }, data: { status: "QUEUED", completed_at: null, requires_human_review: false } });
  return { manuscriptId: audit.manuscript_id, revisionNo: audit.revision_no };
};

// ── Notifications / author report ───────────────────────────────────────────────────

const notifyAfterAudit = async (manuscript, auditId, outcome) => {
  if (outcome === OUTCOMES.MANUAL) {
    const staff = await prisma.profile.findMany({ where: { OR: [{ role: "editor" }, { is_editor: true }] }, select: { id: true } });
    await Promise.all(
      staff.map((s) =>
        createNotification({
          user_id: s.id,
          title: "Integrity audit needs editorial review",
          message: `"${manuscript.title}" could not be cleared automatically and is waiting in the audit review queue.`,
          type: "warning",
        }),
      ),
    );
    return;
  }
  const author = await prisma.profile.findUnique({ where: { id: manuscript.author_id }, select: { id: true, email: true, full_name: true } });
  if (!author) return;
  const label = {
    [OUTCOMES.PASSED]: "cleared — you can now pay the Article Processing Charge",
    [OUTCOMES.REVISION]: "completed — revisions are required (no new evaluation fee)",
    [OUTCOMES.REJECTED]: "completed — the manuscript was not accepted into peer review",
  }[outcome];
  await createNotification({
    user_id: author.id,
    title: "Integrity & citation report ready",
    message: `The Stage 2 audit of "${manuscript.title}" is ${label}. Open the manuscript to read the full report.`,
    type: outcome === OUTCOMES.PASSED ? "success" : "info",
  });
  if (author.email) {
    const report = await buildAuthorReport(auditId, { staff: false });
    await sendIntegrityAuditReportEmail({
      to: author.email,
      recipientId: author.id,
      name: author.full_name ?? "Author",
      title: manuscript.title,
      decision: outcome,
      requiredActions: report.requiredActions,
    });
  }
};

export const buildAuthorReport = async (auditId, { staff }) => {
  const cfg = await getActiveConfig();
  const audit = await prisma.manuscriptIntegrityAudit.findUnique({
    where: { id: auditId },
    include: {
      citations: { orderBy: { bibliography_index: "asc" } },
      recommendations: { orderBy: { rank_position: "asc" } },
    },
  });
  if (!audit) throw httpError(404, "Audit not found");
  const ev = audit.evidence_payload ?? {};
  const showAiScore = staff || cfg.expose_raw_ai_score;

  return {
    auditId: audit.id,
    manuscriptId: audit.manuscript_id,
    revisionNo: audit.revision_no,
    status: audit.status,
    decision: audit.decision,
    reasonCodes: audit.policy_rules_hit,
    requiredActions: ev.required_actions ?? [],
    plagiarism: {
      risk: audit.plagiarism_risk,
      provider: audit.plagiarism_provider,
      matches: ev.plagiarism_matches ?? [],
      exclusions: "Bibliography excluded from comparison",
      coverage: ev.plagiarism_coverage ?? null,
      flags: ev.plagiarism_flags ?? [],
    },
    aiAuthorship: {
      riskBand: audit.ai_risk_band,
      provider: audit.ai_detector_provider,
      modelVersion: audit.ai_detector_model_version,
      ...(showAiScore ? { score: audit.ai_risk_score === null ? null : Number(audit.ai_risk_score) } : {}),
      flaggedSegments: ev.ai_flagged_segments ?? [],
      disclaimer: DISCLAIMER,
    },
    citationLedger: audit.citations.map((c) => ({
      id: c.id,
      bibliographyIndex: c.bibliography_index,
      rawReference: c.raw_reference,
      resolutionStatus: c.resolution_status,
      resolvedDoi: c.resolved_doi,
      openalexId: c.openalex_work_id,
      warnings: c.warning_codes,
      relevanceScore: c.semantic_relevance_score === null ? null : Number(c.semantic_relevance_score),
    })),
    orphanedMarkers: ev.orphaned_markers ?? [],
    relatedRecommendations: audit.recommendations.map((r) => ({
      id: r.id,
      title: r.title,
      year: r.publication_year,
      doi: r.doi,
      externalWorkId: r.external_work_id,
      source: r.source,
      relevanceScore: Number(r.relevance_score),
      reason: r.recommendation_reason,
      selected: r.selected_by_author,
    })),
    disclaimer: "Recommended related papers are suggestions only; nothing is added to your manuscript or bibliography without your action.",
    generatedAt: audit.completed_at,
    ...(staff
      ? {
          internal: {
            requiresHumanReview: audit.requires_human_review,
            componentErrors: ev.component_errors ?? {},
            incompleteComponents: ev.incomplete_components ?? [],
            configRevisionId: audit.config_revision_id,
            resolvedBy: audit.resolved_by,
            resolvedReason: audit.resolved_reason,
          },
        }
      : {}),
  };
};
