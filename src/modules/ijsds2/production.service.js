import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { StorageService } from "../../services/storage.service.js";
import { httpError } from "./ijsds2.constants.js";
import { fetchFileBuffer, extractText, parseManuscriptText, extractDocxStructured } from "./manuscriptParser.js";
import { invokeStructuredTask } from "./aiGateway.service.js";
import {
  ARCHIVE_TEMPLATE_PROVENANCE,
  JOURNAL_CONSTANTS,
  applyAcceptedProposals,
  buildCanonicalBlocks,
  generateJatsXml,
  renderPublicationHtml,
  sha256Hex,
  verifyContentPreservation,
} from "./contentPreservation.js";
import {
  renderHtmlToPdfBuffer,
  rasterizePdfToPngBase64,
  runStage6eVisualQa,
} from "./pdfRenderer.service.js";
import { transitionManuscript } from "./stateMachine.js";

const DEFAULT_TEMPLATE_STYLE = Object.freeze({
  pageSize: "A4",
  marginsMm: { top: 24, right: 18, bottom: 20, left: 18 },
  bodyColumns: 2,
  columnGapMm: 7.5,
  serifFont: "Times New Roman",
  coverDisplayFont: "Montserrat / Arial Narrow",
  coverNavy: "#0b1a33",
  rsuGreen: "#148040",
  issnPrint: JOURNAL_CONSTANTS.issnPrint,
  issnOnline: JOURNAL_CONSTANTS.issnOnline,
  dynamicFields: ["volume", "issue", "doi", "authors", "affiliations", "orcids", "pageNumbers"],
});

const COPYEDIT_PROPOSALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "blockId",
          "section",
          "category",
          "severity",
          "originalQuote",
          "proposedText",
          "rationale",
          "verifiedSourceDoi",
          "confidence",
        ],
        properties: {
          blockId: { type: "string" },
          section: { type: "string" },
          category: {
            type: "string",
            enum: [
              "grammar",
              "apa7",
              "doi_enrichment",
              "numeric_consistency",
              "terminology",
              "structure",
              "missing_declaration",
            ],
          },
          severity: { type: "string", enum: ["blocker", "recommended", "suggestion"] },
          originalQuote: { type: "string" },
          proposedText: { type: "string" },
          rationale: { type: "string" },
          verifiedSourceDoi: { type: ["string", "null"] },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const LAYOUT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["articleType", "columnLayout", "tablePlacement", "pageBreakHints"],
  properties: {
    articleType: { type: "string" },
    columnLayout: { type: "string", enum: ["single", "two_column_body"] },
    tablePlacement: { type: "string", enum: ["inline", "top_float"] },
    pageBreakHints: { type: "array", items: { type: "string" } },
  },
};

const COPYEDIT_SYSTEM_PROMPT = `You are a meticulous academic copyeditor for the International Journal of Social Work and Development Studies (IJSDS, Rivers State University, APA 7th edition).
Return ONLY structured, non-destructive edit proposals anchored to exact blockId and verbatim originalQuote substrings from the provided manuscript blocks.

NON-NEGOTIABLE INTEGRITY & PUBLICATION-READY RULES:
1. NEVER alter research findings, statistical values, sample sizes, methodology claims, or author arguments.
2. Preserve African/regional social work terminology, Nigerian/Global South policy terms, and the author's scholarly voice. Do not rewrite clear academic prose into generic AI phrasing.
3. Focus strictly on: grammar/punctuation, spelling, clarity, and APA 7th citation & reference formatting.
4. NEVER fabricate DOIs, references, funding statements, or ethics approvals. Only include verifiedSourceDoi if present in the input context.
5. Every originalQuote MUST appear verbatim inside the referenced blockId.
6. CRITICAL — PUBLICATION-READY TEXT ONLY: Every proposedText MUST be clean, direct, drop-in publishable manuscript prose that can immediately replace originalQuote in the final published PDF. NEVER put editorial instructions, bracketed tags, or notes inside proposedText (e.g. NEVER write "[Action required]", "[TODO]", "[Verify]", "[Insert ...]", "Reconcile...", or "Author should..."). Put explanations ONLY in rationale. If an issue cannot be fixed cleanly as direct drop-in replacement text, do NOT emit a proposal for it.
7. NEVER use em dashes (—) in proposedText. Use commas, parentheses, colons, or semicolons instead.`;

const shapeTemplate = (t) => ({
  id: t.id,
  version: t.version,
  variant: t.variant,
  rendererVersion: t.renderer_version,
  status: t.status,
  approvedBy: t.approved_by,
  approvedAt: t.approved_at ? t.approved_at.toISOString() : null,
  goldenPageKeys: t.golden_page_keys ?? [],
});

const shapeCopyeditRun = (run) =>
  run
    ? {
        runId: run.id,
        articleId: run.article_id,
        manuscriptVersionId: run.manuscript_id ?? null,
        provider: run.provider,
        model: run.model,
        promptVersion: run.prompt_version,
        status: run.status,
        approvedCopyeditHash: run.approved_copyedit_hash ?? null,
        lockedBy: run.locked_by ?? null,
        lockedAt: run.locked_at ? run.locked_at.toISOString() : null,
        proposals: (run.proposals ?? []).map((p) => ({
          id: p.id,
          blockId: p.block_id,
          section: p.section,
          category: p.category,
          severity: p.severity,
          originalQuote: p.original_quote,
          proposedText: p.proposed_text,
          rationale: p.rationale,
          verifiedSourceDoi: p.verified_source_doi ?? null,
          confidence: Number(p.confidence ?? 0.8),
          status: p.status,
          reviewedBy: p.reviewed_by ?? null,
          reviewedAt: p.reviewed_at ? p.reviewed_at.toISOString() : null,
        })),
        createdAt: run.created_at.toISOString(),
      }
    : null;

const trySignUrl = async (objectKey) => {
  if (!objectKey || objectKey.startsWith("inline://")) return null;
  try {
    return await StorageService.getSignedUrl(objectKey, 3600);
  } catch {
    return null;
  }
};

const shapeProductionRun = async (run) => {
  if (!run) return null;
  const artefacts = await Promise.all(
    (run.artefacts ?? []).map(async (a) => ({
      id: a.id,
      productionRunId: a.production_run_id,
      type: a.type,
      objectKey: a.object_key,
      signedUrl: await trySignUrl(a.object_key),
      sha256: a.sha256,
      pageCount: a.page_count ?? null,
      qaStatus: a.qa_status,
      createdAt: a.created_at.toISOString(),
    })),
  );
  const latestQa = (run.qa_reports ?? [])[0] ?? null;

  return {
    id: run.id,
    articleId: run.article_id,
    manuscriptId: run.manuscript_id ?? null,
    versionId: null,
    runNo: run.run_no,
    substate: run.substate,
    templateId: run.template_id,
    templateVersion: run.template?.version ?? null,
    rendererVersion: run.renderer_version,
    acceptedContentHash: run.accepted_content_hash,
    approvedCopyeditHash: run.approved_copyedit_hash,
    artefacts,
    qaReport: latestQa
      ? {
          id: latestQa.id,
          productionRunId: latestQa.production_run_id,
          status: latestQa.status,
          contentPreservation: latestQa.content_preservation,
          visualFindings: latestQa.visual_findings ?? [],
          visionProvider: latestQa.vision_provider ?? null,
          visionModel: latestQa.vision_model ?? null,
          checkedAt: latestQa.checked_at.toISOString(),
        }
      : null,
    approvals: (run.approvals ?? []).map((a) => ({
      id: a.id,
      productionRunId: a.production_run_id,
      artefactSha256: a.artefact_sha256,
      role: a.role,
      actorId: a.actor_id,
      actorName: a.actor_name ?? null,
      decision: a.decision,
      reason: a.reason,
      createdAt: a.created_at.toISOString(),
    })),
    totalCostUsd: Number(run.total_cost_usd ?? 0),
    createdAt: run.created_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
  };
};

const loadArticleWithManuscript = async (articleId) => {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    include: {
      file_versions: { where: { is_archived: false }, orderBy: { version_number: "desc" } },
      submissions: { include: { manuscript: true }, orderBy: { submitted_at: "desc" }, take: 1 },
    },
  });
  if (!article) throw httpError(404, "Article not found");
  const manuscript = article.submissions?.[0]?.manuscript ?? null;
  return { article, manuscript };
};

export const listTemplates = async (status) => {
  let rows = await prisma.publicationTemplate.findMany({
    where: status ? { status } : {},
    orderBy: { created_at: "desc" },
  });
  if (rows.length === 0 && (!status || status === "ACTIVE")) {
    const seeded = await prisma.publicationTemplate.create({
      data: {
        version: ARCHIVE_TEMPLATE_PROVENANCE.templateVersion,
        variant: "research_article",
        archive_source_manifest: ARCHIVE_TEMPLATE_PROVENANCE,
        style_manifest: DEFAULT_TEMPLATE_STYLE,
        style_manifest_sha256: sha256Hex(DEFAULT_TEMPLATE_STYLE),
        golden_page_keys: [],
        renderer_version: "chromium-paged-pdf-v2.0",
        status: "ACTIVE",
        approved_at: new Date(),
      },
    });
    rows = [seeded];
  }
  return rows.map(shapeTemplate);
};

export const getLatestCopyeditRun = async (articleId) => {
  const run = await prisma.copyeditRun.findFirst({
    where: { article_id: articleId },
    orderBy: { created_at: "desc" },
    include: { proposals: { orderBy: { block_id: "asc" } } },
  });
  return shapeCopyeditRun(run);
};

export const triggerCopyeditRun = async (articleId) => {
  const { article, manuscript } = await loadArticleWithManuscript(articleId);

  const fileUrl =
    article.file_versions?.find((f) => f.file_url?.toLowerCase().endsWith(".docx"))?.file_url ??
    article.file_versions?.[0]?.file_url ??
    article.manuscript_file_url;

  let bodyText = "";
  let bodyItems = null;
  let referencesText = "";
  if (fileUrl) {
    const buffer = await fetchFileBuffer(fileUrl);
    if (fileUrl.split("?")[0].toLowerCase().endsWith(".docx")) {
      const structured = await extractDocxStructured(buffer).catch(() => null);
      if (structured && structured.body_items.length > 0) {
        bodyItems = structured.body_items;
        referencesText = structured.references_text;
      }
    }
    if (!bodyItems) {
      const rawText = await extractText(buffer, fileUrl);
      const parsed = parseManuscriptText(rawText);
      bodyText = parsed.body_text;
      referencesText = parsed.references_text;
    }
  }

  const blocks = buildCanonicalBlocks({
    title: article.title,
    abstract: article.abstract,
    bodyText,
    bodyItems,
    referencesText,
  });
  if (blocks.length === 0) throw httpError(400, "No readable manuscript content found for copyediting");

  const acceptedContentHash = sha256Hex(blocks);
  const blockMap = new Map(blocks.map((b) => [b.blockId, b]));

  const compactBlocksPrompt = JSON.stringify(
    blocks.slice(0, 120).map((b) => ({ blockId: b.blockId, section: b.section, text: b.text.slice(0, 2500) })),
  );

  // Create a RUNNING job immediately so Azure/HTTP proxies never time out on long manuscripts.
  const pendingRun = await prisma.copyeditRun.create({
    data: {
      article_id: article.id,
      manuscript_id: manuscript?.id ?? null,
      provider: "openai",
      model: "gpt-5",
      prompt_version: "v1.0.0",
      status: "RUNNING",
      accepted_content_hash: acceptedContentHash,
      canonical_blocks: blocks,
    },
    include: { proposals: true },
  });

  // Execute AI copyedit in the background and update the CopyeditRun row when finished.
  setImmediate(async () => {
    try {
      const aiResult = await invokeStructuredTask({
        manuscriptId: manuscript?.id ?? null,
        articleId: article.id,
        stage: "stage6",
        task: "stage6a_copyedit",
        systemPrompt: COPYEDIT_SYSTEM_PROMPT,
        userPrompt: `Article metadata:
Title: ${article.title}
Funding recorded: ${article.funding_info ? "YES" : "NO"}
COI recorded: ${article.conflicts_of_interest ? "YES" : "NO"}
Manuscript blocks (JSON):
${compactBlocksPrompt}`,
        jsonSchema: COPYEDIT_PROPOSALS_SCHEMA,
        idempotencyKey: `stage6a:${article.id}:${acceptedContentHash}:${pendingRun.id}`,
      });

      if (aiResult.skipped) {
        await prisma.copyeditRun.update({
          where: { id: pendingRun.id },
          data: { status: "FAILED" },
        });
        return;
      }

      const NON_PUBLISHABLE_PROPOSAL_RE =
        /\[(?:action\s*required|todo|tbd|verify|confirm|insert|note|editor|author|missing)[^\]]*\]|^(?:reconcile|verify|confirm|please\s+verify|author\s+should|add\s+a\s+)/i;

      const rawProposals = Array.isArray(aiResult.output?.proposals) ? aiResult.output.proposals : [];
      const verifiedProposals = rawProposals.filter((p) => {
        const block = blockMap.get(p?.blockId);
        if (!block) return false;
        if (!p.originalQuote || !block.text.includes(p.originalQuote)) return false;
        if (!p.proposedText || p.proposedText === p.originalQuote) return false;
        if (String(p.proposedText).includes("—")) return false;
        if (NON_PUBLISHABLE_PROPOSAL_RE.test(String(p.proposedText).trim())) return false;
        return true;
      });

      await prisma.copyeditRun.update({
        where: { id: pendingRun.id },
        data: {
          ai_run_id: aiResult.runId ?? null,
          provider: aiResult.provider,
          model: aiResult.model,
          prompt_version: aiResult.promptVersion,
          status: "COMPLETED",
          proposals: {
            create: verifiedProposals.map((p) => ({
              block_id: p.blockId,
              section: p.section || blockMap.get(p.blockId).section,
              category: p.category,
              severity: p.severity,
              original_quote: p.originalQuote,
              proposed_text: p.proposedText,
              rationale: p.rationale,
              verified_source_doi: p.verifiedSourceDoi ?? null,
              confidence: Math.min(1, Math.max(0, Number(p.confidence ?? 0.85))),
              status: "pending",
            })),
          },
        },
      });
    } catch (err) {
      console.error("[stage6a] background copyedit failed:", err.message);
      await prisma.copyeditRun
        .update({ where: { id: pendingRun.id }, data: { status: "FAILED" } })
        .catch(() => {});
    }
  });

  return shapeCopyeditRun(pendingRun);
};

export const decideCopyeditProposal = async (articleId, proposalId, status, actor) => {
  if (!["accepted", "rejected"].includes(status)) {
    throw httpError(400, "status must be 'accepted' or 'rejected'");
  }
  const proposal = await prisma.copyeditProposal.findUnique({
    where: { id: proposalId },
    include: { copyedit_run: true },
  });
  if (!proposal || proposal.copyedit_run.article_id !== articleId) {
    throw httpError(404, "Copyedit proposal not found");
  }
  if (proposal.copyedit_run.status === "LOCKED") {
    throw httpError(409, "Copyedit run is already locked; start a new copyedit pass to make further changes");
  }
  const updated = await prisma.copyeditProposal.update({
    where: { id: proposalId },
    data: { status, reviewed_by: actor.id, reviewed_at: new Date() },
  });
  return { id: updated.id, status: updated.status };
};

export const lockApprovedCopyedit = async (articleId, actor) => {
  const run = await prisma.copyeditRun.findFirst({
    where: { article_id: articleId },
    orderBy: { created_at: "desc" },
    include: { proposals: true },
  });
  if (!run) throw httpError(404, "No copyedit run found for this article");
  if (run.status === "LOCKED" && run.approved_copyedit_hash) {
    return { approvedCopyeditHash: run.approved_copyedit_hash, lockedAt: run.locked_at.toISOString() };
  }

  const pendingBlockers = run.proposals.filter((p) => p.severity === "blocker" && p.status === "pending");
  if (pendingBlockers.length > 0) {
    throw httpError(409, `Resolve ${pendingBlockers.length} pending blocking copyedit item(s) before locking`);
  }

  const canonicalBlocks = Array.isArray(run.canonical_blocks) ? run.canonical_blocks : [];
  const lockedBlocks = applyAcceptedProposals(canonicalBlocks, run.proposals);
  const approvedCopyeditHash = sha256Hex(lockedBlocks);
  const lockedAt = new Date();

  await prisma.copyeditRun.update({
    where: { id: run.id },
    data: {
      status: "LOCKED",
      locked_blocks: lockedBlocks,
      approved_copyedit_hash: approvedCopyeditHash,
      locked_by: actor.id,
      locked_at: lockedAt,
    },
  });

  return { approvedCopyeditHash, lockedAt: lockedAt.toISOString() };
};

export const getLatestProductionRun = async (articleId) => {
  const run = await prisma.productionRun.findFirst({
    where: { article_id: articleId },
    orderBy: { created_at: "desc" },
    include: {
      template: true,
      artefacts: { orderBy: { created_at: "asc" } },
      qa_reports: { orderBy: { checked_at: "desc" }, take: 1 },
      approvals: { orderBy: { created_at: "asc" } },
    },
  });
  return shapeProductionRun(run);
};

const stripTagsForD02 = (html) =>
  String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const safeUploadArtefact = async (objectKey, buffer, mimeType) => {
  try {
    if (process.env.SUPABASE_BUCKET_NAME) {
      await StorageService.upload(objectKey, buffer, mimeType);
      return objectKey;
    }
  } catch (err) {
    console.warn("[stage6] storage upload fallback:", err.message);
  }
  return `inline://${objectKey}`;
};

export const startProductionRun = async (articleId, { templateId } = {}) => {
  const { article, manuscript } = await loadArticleWithManuscript(articleId);

  const lockedCopyedit = await prisma.copyeditRun.findFirst({
    where: { article_id: article.id, status: "LOCKED" },
    orderBy: { locked_at: "desc" },
  });
  if (!lockedCopyedit || !lockedCopyedit.approved_copyedit_hash) {
    throw httpError(409, "Lock the approved Stage 6 copyedit before generating proofs");
  }

  const activeTemplates = await listTemplates("ACTIVE");
  const template = templateId
    ? activeTemplates.find((t) => t.id === templateId)
    : activeTemplates[0];
  if (!template) throw httpError(409, "No ACTIVE approved publication template available");

  const lockedBlocks = Array.isArray(lockedCopyedit.locked_blocks)
    ? lockedCopyedit.locked_blocks
    : [];

  // Optional 6C AI layout planner (degrades cleanly to deterministic layout defaults)
  let layoutPlan = { articleType: "research_article", columnLayout: "single", tablePlacement: "inline", pageBreakHints: [] };
  const aiRunIds = [];
  let totalCostUsd = 0;

  try {
    const planRes = await invokeStructuredTask({
      manuscriptId: manuscript?.id ?? null,
      articleId: article.id,
      stage: "stage6",
      task: "stage6c_layout_plan",
      systemPrompt:
        "You plan publication layout slots for an academic journal PDF. Output allowlisted layout parameters only; never output executable code or rewrite body text.",
      userPrompt: `Article title: ${article.title}. Total blocks: ${lockedBlocks.length}. References: ${
        lockedBlocks.filter((b) => b.section === "References").length
      }. Template: ${template.variant} v${template.version}.`,
      jsonSchema: LAYOUT_PLAN_SCHEMA,
      idempotencyKey: `stage6c:${article.id}:${lockedCopyedit.approved_copyedit_hash}:${Date.now()}`,
    });
    if (!planRes.skipped && planRes.output) {
      layoutPlan = planRes.output;
      if (planRes.runId) aiRunIds.push(planRes.runId);
      totalCostUsd += planRes.usage?.costUsd ?? 0;
    }
  } catch {
    // Non-fatal: deterministic default layout plan applies.
  }

  // Deterministic 6D typesetting: JATS 1.3 XML + real searchable PDF via headless Chrome (with HTML fallback)
  const jatsXml = generateJatsXml({ article, blocks: lockedBlocks });
  const proofHtml = renderPublicationHtml({ article, blocks: lockedBlocks });
  const jatsSha = sha256Hex(jatsXml);

  const renderedPdf = await renderHtmlToPdfBuffer(proofHtml).catch((err) => {
    console.warn("[stage6] headless PDF compile fallback to HTML:", err.message);
    return null;
  });

  const proofBuffer = renderedPdf ? renderedPdf.pdfBuffer : Buffer.from(proofHtml, "utf8");
  const proofMime = renderedPdf ? "application/pdf" : "text/html";
  const proofExt = renderedPdf ? "pdf" : "html";
  const proofSha = sha256Hex(proofBuffer);
  const effectiveRendererVersion = renderedPdf ? renderedPdf.rendererVersion : template.rendererVersion;

  // Deterministic D02 Content Preservation Gate — runs against ACTUAL rendered PDF bytes when available!
  let extractedRenderedText = stripTagsForD02(proofHtml);
  if (renderedPdf) {
    try {
      extractedRenderedText = await extractText(renderedPdf.pdfBuffer, "proof.pdf");
    } catch (err) {
      console.warn("[stage6] PDF text extraction fallback:", err.message);
    }
  }

  const contentPreservation = verifyContentPreservation({
    approvedCopyeditHash: lockedCopyedit.approved_copyedit_hash,
    canonicalBlocks: lockedBlocks,
    renderedPlainText: extractedRenderedText,
    expectedMetadata: {
      title: article.title,
      doi: article.crossrefDoi || article.doi || null,
      issnOnline: JOURNAL_CONSTANTS.issnOnline,
      volume: article.volume ?? null,
      issue: article.issue ?? null,
    },
  });

  const existingCount = await prisma.productionRun.count({ where: { article_id: article.id } });
  const runNo = existingCount + 1;

  // D03 Multimodal Vision QA on rasterized PDF pages (gpt-5 Vision)
  let pageCount = null;
  let visualQa = { skipped: true, findings: [], provider: null, model: null, runId: null, costUsd: 0 };
  if (renderedPdf) {
    const rasterized = await rasterizePdfToPngBase64(renderedPdf.pdfBuffer).catch(() => null);
    if (rasterized) {
      pageCount = rasterized.pageCount;
      visualQa = await runStage6eVisualQa({
        articleId: article.id,
        manuscriptId: manuscript?.id ?? null,
        runNo,
        pages: rasterized.pages,
      });
      if (visualQa.runId) aiRunIds.push(visualQa.runId);
      totalCostUsd += visualQa.costUsd ?? 0;
    }
  }

  const prefix = `stage6/${article.id}/run-${runNo}`;
  const jatsKey = await safeUploadArtefact(`${prefix}/article.jats.xml`, Buffer.from(jatsXml, "utf8"), "application/xml");
  const proofKey = await safeUploadArtefact(`${prefix}/proof.${proofExt}`, proofBuffer, proofMime);

  const metadataSnapshot = {
    title: article.title,
    volume: article.volume ?? null,
    issue: article.issue ?? null,
    pageStart: article.page_start ?? null,
    pageEnd: article.page_end ?? null,
    doi: article.crossrefDoi || article.doi || null,
    issnPrint: JOURNAL_CONSTANTS.issnPrint,
    issnOnline: JOURNAL_CONSTANTS.issnOnline,
  };

  const hasVisualBlocker = visualQa.findings.some((f) => f.severity === "blocker");
  const qaPassed = contentPreservation.passed && !hasVisualBlocker;
  const qaStatus = qaPassed ? "PASSED" : "MANUAL_REVIEW";
  const substate = qaPassed ? "PROOF_PENDING" : "MANUAL_REVIEW";

  const created = await prisma.productionRun.create({
    data: {
      article_id: article.id,
      manuscript_id: manuscript?.id ?? null,
      copyedit_run_id: lockedCopyedit.id,
      template_id: template.id,
      run_no: runNo,
      substate,
      accepted_content_hash: lockedCopyedit.accepted_content_hash ?? lockedCopyedit.approved_copyedit_hash,
      approved_copyedit_hash: lockedCopyedit.approved_copyedit_hash,
      layout_plan_json: layoutPlan,
      renderer_version: effectiveRendererVersion,
      ai_run_ids: aiRunIds,
      total_cost_usd: totalCostUsd,
      idempotency_key: `prod:${article.id}:run-${runNo}:${crypto.randomUUID()}`,
      artefacts: {
        create: [
          {
            type: "PROOF_PDF",
            object_key: proofKey,
            sha256: proofSha,
            metadata_snapshot: metadataSnapshot,
            page_count: pageCount,
            qa_status: qaStatus,
          },
          {
            type: "JATS_XML",
            object_key: jatsKey,
            sha256: jatsSha,
            metadata_snapshot: metadataSnapshot,
            qa_status: qaStatus,
          },
        ],
      },
      qa_reports: {
        create: {
          status: qaStatus,
          content_preservation: contentPreservation,
          visual_findings: visualQa.findings,
          vision_provider: visualQa.provider,
          vision_model: visualQa.model,
        },
      },
    },
    include: {
      template: true,
      artefacts: true,
      qa_reports: true,
      approvals: true,
    },
  });

  return shapeProductionRun(created);
};

export const submitProductionApproval = async (runId, { role, decision, reason, artefactSha256, actor }) => {
  if (!["designer", "editor", "author"].includes(role)) {
    throw httpError(400, "role must be designer, editor, or author");
  }
  if (!["APPROVED", "REJECTED"].includes(decision)) {
    throw httpError(400, "decision must be APPROVED or REJECTED");
  }
  const normalizedReason =
    String(reason ?? "").trim() ||
    (decision === "APPROVED" ? `Approved for publication by ${role}` : `Rejected for repair by ${role}`);

  const run = await prisma.productionRun.findUnique({
    where: { id: runId },
    include: { artefacts: true, qa_reports: { orderBy: { checked_at: "desc" }, take: 1 }, approvals: true },
  });
  if (!run) throw httpError(404, "Production run not found");

  const matchedArtefact = run.artefacts.find((a) => a.sha256 === artefactSha256);
  if (!matchedArtefact) {
    throw httpError(409, "Artefact SHA-256 does not match this production run (proof may be stale)");
  }

  if (decision === "APPROVED" && !run.qa_reports?.[0]?.content_preservation?.passed) {
    throw httpError(409, "Cannot approve proof while D02 Content Preservation QA is blocked");
  }

  const approval = await prisma.productionApproval.create({
    data: {
      production_run_id: run.id,
      artefact_sha256: artefactSha256,
      role,
      actor_id: actor.id,
      actor_name: actor.full_name ?? actor.email ?? null,
      decision,
      reason: normalizedReason,
    },
  });

  if (decision === "REJECTED") {
    await prisma.productionRun.update({ where: { id: run.id }, data: { substate: "MANUAL_REVIEW" } });
  } else {
    const allApprovals = [...run.approvals, approval].filter(
      (a) => a.artefact_sha256 === artefactSha256 && a.decision === "APPROVED",
    );
    const roles = new Set(allApprovals.map((a) => a.role));
    if (roles.has("editor")) {
      const sealedPdf = run.artefacts.find(
        (a) => a.type === "PROOF_PDF" && a.object_key && !a.object_key.startsWith("inline://") && a.object_key.endsWith(".pdf"),
      );
      const sealedPdfUrl = sealedPdf ? StorageService.getPublicUrl(sealedPdf.object_key) : null;

      await prisma.$transaction(async (tx) => {
        await tx.productionRun.update({ where: { id: run.id }, data: { substate: "APPROVED" } });
        await tx.article.update({
          where: { id: run.article_id },
          data: {
            status: "processed",
            ...(sealedPdfUrl ? { manuscript_file_url: sealedPdfUrl } : {}),
          },
        });
        if (run.manuscript_id) {
          const m = await tx.manuscript.findUnique({ where: { id: run.manuscript_id } });
          if (m?.current_state === "IN_PRODUCTION") {
            await transitionManuscript(
              tx,
              m.id,
              "IN_PRODUCTION",
              "READY_FOR_RELEASE",
              {},
              { changedBy: actor.id, reason: `Stage 6 proof sealed (${artefactSha256.slice(0, 12)})` },
            );
          }
        }
      });
    }
  }

  return {
    id: approval.id,
    productionRunId: approval.production_run_id,
    artefactSha256: approval.artefact_sha256,
    role: approval.role,
    actorId: approval.actor_id,
    actorName: approval.actor_name,
    decision: approval.decision,
    reason: approval.reason,
    createdAt: approval.created_at.toISOString(),
  };
};
