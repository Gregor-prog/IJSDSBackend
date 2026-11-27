import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AI_ROUTING,
  mergeAiRoutingDefaults,
  validateAiRouting,
} from "../src/modules/ijsds2/aiRouting.config.js";
import {
  estimateCostUsd,
  invokeStructuredTask,
} from "../src/modules/ijsds2/aiGateway.service.js";
import {
  JOURNAL_CONSTANTS,
  applyAcceptedProposals,
  buildCanonicalBlocks,
  generateJatsXml,
  renderPublicationHtml,
  sha256Hex,
  verifyContentPreservation,
} from "../src/modules/ijsds2/contentPreservation.js";
import { resolveEmbeddingsConfig, isConfigured as embeddingsConfigured } from "../src/modules/ijsds2/embeddings.js";
import { runStage2aScreening, runStage2fSynthesis } from "../src/modules/ijsds2/stage2Ai.service.js";
import { extractManuscriptProfile, scoreReviewerCandidate } from "../src/modules/ijsds2/stage3Ai.service.js";
import {
  renderHtmlToPdfBuffer,
  rasterizePdfToPngBase64,
  runStage6eVisualQa,
} from "../src/modules/ijsds2/pdfRenderer.service.js";
import { extractText, parseHtmlToStructuredManuscript } from "../src/modules/ijsds2/manuscriptParser.js";
import { evaluateProfileVerification } from "../src/modules/profiles/profiles.service.js";

// ── 1. Multi-provider AI routing configuration ─────────────────────────────────────────

test("ai routing defaults use OpenAI paid commercial API cascade and gate Stage 4 off", () => {
  assert.equal(DEFAULT_AI_ROUTING.requireCommercialPaidTier, true);
  assert.equal(DEFAULT_AI_ROUTING.routes.stage2a_screening.provider, "openai");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage2a_screening.model, "gpt-5-mini");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage2e_embeddings.model, "text-embedding-3-small");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage2f_synthesis.model, "gpt-5");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage6a_copyedit.provider, "openai");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage6a_copyedit.model, "gpt-5");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage6e_visual_qa.model, "gpt-5");
  assert.equal(DEFAULT_AI_ROUTING.routes.stage4a_analysis.enabled, false);
  assert.doesNotThrow(() => validateAiRouting(DEFAULT_AI_ROUTING));
});

test("ai routing validation rejects invalid providers and out-of-range caps", () => {
  const badProvider = mergeAiRoutingDefaults({
    routes: { stage6a_copyedit: { provider: "openrouter-free" } },
  });
  assert.throws(() => validateAiRouting(badProvider), /Invalid provider/);

  const badCap = mergeAiRoutingDefaults({ perManuscriptCapUsd: 0 });
  assert.throws(() => validateAiRouting(badCap), /perManuscriptCapUsd/);
});

// ── 2. Direct-API multi-provider aiGateway ─────────────────────────────────────────────

test("aiGateway skips disabled Stage 4 tasks without making network calls", async () => {
  let called = 0;
  const res = await invokeStructuredTask(
    {
      stage: "stage4",
      task: "stage4a_analysis",
      systemPrompt: "sys",
      userPrompt: "user",
    },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      fetchImpl: async () => {
        called += 1;
        throw new Error("should not call fetch");
      },
    },
  );
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "TASK_DISABLED");
  assert.equal(called, 0);
});

test("aiGateway sends Gemini API key via x-goog-api-key header (never query string) and parses JSON", async () => {
  let seenUrl = "";
  let seenHeaders = {};
  const geminiRouting = mergeAiRoutingDefaults({
    routes: { stage2a_screening: { provider: "google", model: "gemini-2.5-flash" } },
  });
  const res = await invokeStructuredTask(
    {
      stage: "stage2",
      task: "stage2a_screening",
      systemPrompt: "screen",
      userPrompt: "paper text",
    },
    {
      routing: geminiRouting,
      db: null,
      env: { GEMINI_API_KEY: "test-gemini-paid-key" },
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ inScope: true }) }] } }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
          }),
        };
      },
    },
  );
  assert.equal(res.skipped, false);
  assert.equal(res.provider, "google");
  assert.deepEqual(res.output, { inScope: true });
  assert.equal(seenUrl.includes("test-gemini-paid-key"), false);
  assert.equal(seenHeaders["x-goog-api-key"], "test-gemini-paid-key");
});

test("aiGateway falls back cleanly when primary model/provider fails", async () => {
  const calls = [];
  const res = await invokeStructuredTask(
    {
      stage: "stage2",
      task: "stage2a_screening",
      systemPrompt: "screen",
      userPrompt: "blocks",
    },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      env: { OPENAI_API_KEY: "test-oai" },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.model);
        if (body.model === "gpt-5-mini") {
          return { ok: false, status: 503, text: async () => "overloaded" };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ inScope: true }) } }],
            usage: { prompt_tokens: 2000, completion_tokens: 200 },
          }),
        };
      },
    },
  );
  assert.deepEqual(calls, ["gpt-5-mini", "gpt-5"]);
  assert.equal(res.provider, "openai");
  assert.equal(res.model, "gpt-5");
  assert.deepEqual(res.output, { inScope: true });
  assert.ok(estimateCostUsd("gpt-5", 2000, 200) > 0);
});

test("aiGateway enforces per-manuscript USD budget cap before calling any provider", async () => {
  let called = 0;
  const mockDb = {
    aiTaskRun: {
      aggregate: async () => ({ _sum: { cost_usd: 0.8 } }),
    },
  };
  const res = await invokeStructuredTask(
    {
      manuscriptId: "00000000-0000-0000-0000-000000000001",
      stage: "stage6",
      task: "stage6a_copyedit",
      systemPrompt: "copyedit",
      userPrompt: "blocks",
    },
    {
      routing: DEFAULT_AI_ROUTING,
      db: mockDb,
      env: { ANTHROPIC_API_KEY: "test-ant" },
      fetchImpl: async () => {
        called += 1;
        throw new Error("should not call");
      },
    },
  );
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "BUDGET_CAP_EXCEEDED");
  assert.equal(called, 0);
});

// ── 3. Stage 6 deterministic content preservation (D02), JATS 1.3 & HTML proof ─────────

test("applyAcceptedProposals applies ONLY accepted edits and ignores pending/rejected proposals", () => {
  const blocks = buildCanonicalBlocks({
    title: "Social Work Practice in Rivers State",
    abstract: "This study surveyed 240 respondents with p < 0.05 significance.",
    bodyText: "Table 1 summarizes the 240 households in Port Harcourt.\n\nFindings show 68.5% uptake.",
    referencesText: "Ogbanga, M. M. (2025). Social welfare policy in Nigeria. IJSDS, 1(1), 1–15.",
  });

  const locked = applyAcceptedProposals(blocks, [
    {
      block_id: "p-001",
      original_quote: "Port Harcourt",
      proposed_text: "Port Harcourt, Nigeria",
      status: "accepted",
    },
    {
      block_id: "p-002",
      original_quote: "68.5%",
      proposed_text: "70.0%",
      status: "rejected",
    },
    {
      block_id: "sec-abstract",
      original_quote: "240 respondents",
      proposed_text: "250 respondents",
      status: "pending",
    },
  ]);

  assert.ok(locked.find((b) => b.blockId === "p-001").text.includes("Port Harcourt, Nigeria"));
  assert.ok(locked.find((b) => b.blockId === "p-002").text.includes("68.5%"));
  assert.ok(locked.find((b) => b.blockId === "sec-abstract").text.includes("240 respondents"));
});

test("D02 verifyContentPreservation passes intact proof HTML and blocks altered numbers or dropped refs", () => {
  const article = {
    id: "art-100",
    title: "Youth Resilience and Community Welfare in Nigeria",
    abstract: "This study analyzed 312 households (p < 0.01) across three districts.",
    keywords: ["social work", "youth", "Nigeria"],
    authors: [
      {
        name: "Prof. Mina Magaret Ogbanga (PhD)",
        affiliation: "Rivers State University",
        orcid: "0000-0002-1825-0097",
      },
    ],
    volume: 2,
    issue: 11,
    page_start: 10,
    page_end: 24,
    crossrefDoi: "10.67007/ijsds.v2i11.100",
    publication_date: "2026-11-28T00:00:00Z",
  };

  const blocks = buildCanonicalBlocks({
    title: article.title,
    abstract: article.abstract,
    bodyText: "Table 1 shows 74.2% resilience across 312 participants.",
    referencesText: "Nwosu, A. (2024). Urban social protection in West Africa. Policy Press.",
  });
  const approvedHash = sha256Hex(blocks);

  const html = renderPublicationHtml({ article, blocks });
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes(JOURNAL_CONSTANTS.issnOnline));
  assert.ok(html.includes(article.crossrefDoi));

  const plainText = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const okCheck = verifyContentPreservation({
    approvedCopyeditHash: approvedHash,
    canonicalBlocks: blocks,
    renderedPlainText: plainText,
    expectedMetadata: {
      title: article.title,
      doi: article.crossrefDoi,
      issnOnline: JOURNAL_CONSTANTS.issnOnline,
    },
  });
  assert.equal(okCheck.passed, true);
  assert.deepEqual(okCheck.missingNumbers, []);
  assert.deepEqual(okCheck.missingReferences, []);

  // Mutate a critical statistic (74.2% -> 71.2%) — D02 MUST block!
  const tamperedCheck = verifyContentPreservation({
    approvedCopyeditHash: approvedHash,
    canonicalBlocks: blocks,
    renderedPlainText: plainText.replace("74.2%", "71.2%"),
    expectedMetadata: {
      title: article.title,
      doi: article.crossrefDoi,
      issnOnline: JOURNAL_CONSTANTS.issnOnline,
    },
  });
  assert.equal(tamperedCheck.passed, false);
  assert.ok(tamperedCheck.missingNumbers.includes("74.2%"));

  // Verify JATS 1.3 XML includes canonical ISSNs, DOI, ORCID, CC BY 4.0 and references
  const jats = generateJatsXml({ article, blocks });
  assert.ok(jats.includes('dtd-version="1.3"'));
  assert.ok(jats.includes(JOURNAL_CONSTANTS.issnPrint));
  assert.ok(jats.includes(article.crossrefDoi));
  assert.ok(jats.includes("https://orcid.org/0000-0002-1825-0097"));
  assert.ok(jats.includes("https://creativecommons.org/licenses/by/4.0/"));
  assert.ok(jats.includes("<ref-list>"));
});

// ── 4. Single-key OpenAI Embeddings + Stage 2A/2F + Stage 3A/3D + Real PDF D02/D03 ────

test("embeddings auto-configures text-embedding-3-small from OPENAI_API_KEY alone", () => {
  assert.equal(embeddingsConfigured({}), false);
  const cfg = resolveEmbeddingsConfig({ OPENAI_API_KEY: "sk-test-paid" });
  assert.equal(cfg.url, "https://api.openai.com/v1/embeddings");
  assert.equal(cfg.model, "text-embedding-3-small");
  assert.equal(cfg.apiKey, "sk-test-paid");
});

test("Stage 2A screening (gpt-5-mini) and Stage 2F synthesis (gpt-5) return structured evidence", async () => {
  const screening = await runStage2aScreening(
    {
      manuscriptId: "m-1",
      revisionNo: 1,
      title: "Child Welfare Systems in Port Harcourt",
      abstract: "Qualitative interviews with 40 social workers.",
      bodyText: "This qualitative study interviewed 40 social workers in Rivers State.",
    },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  inScope: true,
                  scopeRationale: "Directly addresses social work and child welfare in Nigeria.",
                  articleType: "original_research",
                  anonymizationIssues: [],
                  disclosures: {
                    ethicsStatus: "present",
                    conflictStatus: "present",
                    fundingStatus: "not_applicable",
                    aiUseStatus: "present",
                  },
                  structuralFindings: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 150 },
        }),
      }),
    },
  );
  assert.equal(screening.inScope, true);
  assert.equal(screening.provenance.model, "gpt-5-mini");

  const synthesis = await runStage2fSynthesis(
    {
      manuscriptId: "m-1",
      revisionNo: 1,
      title: "Child Welfare Systems in Port Harcourt",
      decision: { outcome: "AUDIT_PASSED_PENDING_APC", rules: [], actions: [] },
      structural: { word_count: 5200, has_abstract: true, has_references: true, has_ethics_statement: true, has_ai_disclosure: true },
      plagiarism: { score: 0.04, flags: [] },
      ai: { skipped: true },
      citations: { total: 24, unresolved: 1, metadata_mismatch: 0, orphaned_markers: [], uncited_indices: [] },
      screening,
    },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  executiveSummary: "Manuscript meets Stage 2 structural, citation, and disclosure standards.",
                  authorGuidance: [{ priority: "low", category: "Citations", guidance: "Verify 1 local report citation." }],
                  editorNotes: "Clean screening; ready for Gate 2.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 700, completion_tokens: 120 },
        }),
      }),
    },
  );
  assert.equal(synthesis.provenance.model, "gpt-5");
  assert.equal(synthesis.authorGuidance.length, 1);
});

test("Stage 3A profile + Stage 3D deterministic 35/30/15/10/10 explainable scorer", async () => {
  const profile = await extractManuscriptProfile(
    { manuscriptId: "m-2", title: "Community Health in Nigeria", abstract: "Mixed-methods study in Lagos." },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  discipline: "Social Work",
                  subdisciplines: ["Community Health"],
                  methods: ["mixed-methods", "survey"],
                  geographicContext: ["Nigeria", "West Africa"],
                  topicKeywords: ["social work", "community health"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 80 },
        }),
      }),
    },
  );
  assert.equal(profile.discipline, "Social Work");

  const highFit = scoreReviewerCandidate({
    baseSimilarity: 0.85,
    activeLoad: 0,
    isAvailable: true,
    expertiseKeywords: ["social work", "mixed-methods", "survey"],
    bio: "Researcher focused on community health in Nigeria and West Africa.",
    manuscriptProfile: profile,
  });
  const lowFit = scoreReviewerCandidate({
    baseSimilarity: 0.85,
    activeLoad: 2,
    isAvailable: true,
    expertiseKeywords: ["archival history"],
    bio: "European medieval literature.",
    manuscriptProfile: profile,
  });

  assert.equal(highFit.conflictStatus, "CLEAR");
  assert.ok(highFit.compositeSimilarity > lowFit.compositeSimilarity);
  assert.ok(highFit.matchingRationale.includes("matching research methods"));
});

test("parseHtmlToStructuredManuscript preserves Word headings, inline tables, and references", () => {
  const mammothHtml = `
    <h2>1.0 INTRODUCTION</h2>
    <p>Urban informality shapes household well-being across Calabar.</p>
    <h2>2.0 RESULTS</h2>
    <p>Table 1: Distribution of Informal Workers (N = 200)</p>
    <table>
      <tr><th>Category</th><th>Frequency</th><th>Percent</th></tr>
      <tr><td>Traders</td><td>120</td><td>60.0%</td></tr>
      <tr><td>Artisans</td><td>80</td><td>40.0%</td></tr>
    </table>
    <p>References</p>
    <p>Ogbanga, M. M. (2025). Social welfare policy in Nigeria. IJSDS, 1(1), 1-15.</p>
  `;
  const parsed = parseHtmlToStructuredManuscript(mammothHtml);
  assert.equal(parsed.table_count, 1);
  assert.equal(parsed.body_items.filter((i) => i.kind === "heading").length, 2);
  const tbl = parsed.body_items.find((i) => i.kind === "table");
  assert.equal(tbl.caption, "Table 1: Distribution of Informal Workers (N = 200)");
  assert.deepEqual(tbl.headers, ["Category", "Frequency", "Percent"]);
  assert.equal(tbl.rows.length, 2);
  assert.ok(parsed.references_text.includes("Ogbanga, M. M. (2025)"));

  const blocks = buildCanonicalBlocks({
    title: "Test Structured Word Paper",
    abstract: "An abstract of 200 respondents.",
    bodyItems: parsed.body_items,
    referencesText: parsed.references_text,
  });
  assert.ok(blocks.some((b) => b.kind === "table" && b.tableData.rows.length === 2));
});

test("Stage 6 end-to-end: archive-calibrated PDF with dynamic Vol/Iss -> PDF-byte D02 -> pdftoppm PNG -> gpt-5 Vision D03", async () => {
  const article = {
    id: "art-pdf-1",
    title: "Social Protection Programs and Family Resilience in Rivers State",
    abstract: "An empirical study of 185 households demonstrating 62.4% improvement (p < 0.05).",
    keywords: ["social protection", "family resilience", "Rivers State"],
    authors: [{ name: "Dr. Amara Nwosu", affiliation: "University of Lagos", orcid: "0000-0002-1825-0097" }],
    volume: 4,
    issue: 7,
    page_start: 1,
    page_end: 6,
    crossrefDoi: "10.67007/ijsds-2026-v4_i7_201",
    publication_date: "2026-07-28T00:00:00Z",
  };
  const blocks = buildCanonicalBlocks({
    title: article.title,
    abstract: article.abstract,
    bodyText:
      "1.0 INTRODUCTION\n\nSocial protection programs stabilize household resilience in Rivers State.\n\n2.0 RESULTS\n\nTable 1 presents household resilience scores across 185 families showing 62.4% improvement.",
    tables: [
      {
        caption: "Table 1: Household Resilience Scores (N = 185)",
        headers: ["Indicator", "Count", "Share (%)"],
        rows: [["Improved Resilience", "115", "62.4%"]],
      },
    ],
    referencesText: "Ogbanga, M. M. (2025). Social welfare and development in Nigeria. IJSDS, 1(1), 1-14.",
  });

  const html = renderPublicationHtml({ article, blocks });
  assert.ok(html.includes("Volume 4 Issue 7"));
  assert.ok(html.includes("Vol 4 Issue 7"));
  assert.ok(html.includes("Vol. 4. Issue 7."));
  assert.ok(html.includes('<table class="ijsds-table">'));

  const rendered = await renderHtmlToPdfBuffer(html);
  assert.ok(rendered && rendered.pdfBuffer.length > 1000, "Expected real compiled PDF buffer");

  // Extract text straight from the compiled PDF binary and verify D02 Content Preservation + Dynamic Vol/Iss
  const extractedPdfText = await extractText(rendered.pdfBuffer, "proof.pdf");
  assert.ok(extractedPdfText.includes("Volume 4 Issue 7"));
  assert.ok(extractedPdfText.includes("Vol. 4. Issue 7."));

  const d02 = verifyContentPreservation({
    approvedCopyeditHash: sha256Hex(blocks),
    canonicalBlocks: blocks,
    renderedPlainText: extractedPdfText,
    expectedMetadata: {
      title: article.title,
      doi: article.crossrefDoi,
      issnOnline: JOURNAL_CONSTANTS.issnOnline,
      volume: article.volume,
      issue: article.issue,
    },
  });
  assert.equal(d02.passed, true, `D02 failed on real PDF: ${JSON.stringify(d02)}`);

  // Rasterize PDF to PNG pages via pdftoppm when installed; fall back to synthetic PNG page on minimal CI runners
  const raster = await rasterizePdfToPngBase64(rendered.pdfBuffer);
  let qaPages;
  if (raster) {
    assert.ok(raster.pageCount >= 6 && raster.pages[0].base64.length > 500);
    qaPages = raster.pages;
  } else {
    qaPages = [{ page: 1, mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }];
  }

  let sentImageParts = 0;
  const d03 = await runStage6eVisualQa(
    { articleId: article.id, manuscriptId: null, runNo: 1, pages: qaPages },
    {
      routing: DEFAULT_AI_ROUTING,
      db: null,
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        const userMsg = payload.messages.find((m) => m.role === "user");
        sentImageParts = userMsg.content.filter((c) => c.type === "image_url").length;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
            usage: { prompt_tokens: 1800, completion_tokens: 40 },
          }),
        };
      },
    },
  );
  assert.equal(d03.skipped, false);
  assert.equal(d03.model, "gpt-5");
  assert.equal(sentImageParts, qaPages.length);
  assert.deepEqual(d03.findings, []);
});

test("evaluateProfileVerification requires institutional email, ORCID, Google Scholar, and ResearchGate", () => {
  const unverified = evaluateProfileVerification({
    email: "researcher@gmail.com",
    orcid_id: "0000-0002-1825-0097",
    google_scholar_url: "https://scholar.google.com/citations?user=abc123",
    researchgate_url: "https://www.researchgate.net/profile/Ada-Obi",
  });
  assert.equal(unverified.is_verified, false);
  assert.equal(unverified.checks.institutional_email, false);

  const verified = evaluateProfileVerification({
    email: "researcher@gmail.com",
    institutional_email: "ada.obi@ust.edu.ng",
    orcid_id: "0000-0002-1825-0097",
    google_scholar_url: "https://scholar.google.com/citations?user=abc123",
    researchgate_url: "https://www.researchgate.net/profile/Ada-Obi",
  });
  assert.equal(verified.is_verified, true);
  assert.deepEqual(verified.checks, {
    institutional_email: true,
    orcid_id: true,
    google_scholar_url: true,
    researchgate_url: true,
  });
});
