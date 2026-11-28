import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { create } from "xmlbuilder2";

/**
 * Pure, deterministic Stage 6 content-preservation, canonical block anchoring,
 * verified journal scaffolding, JATS 1.3 XML generation, and archive-calibrated
 * IJSDS Paged-Media HTML/PDF template (PRD v2.4.2-PROD §6.2–6.5).
 *
 * Calibrated from official live IJSDS issue PDF:
 *   DOI: 10.67007/ijsds-2026-v2_i2_001
 *   SHA-256: 6ad0434e3d936486a581c38198391050c80387139e136d9080a8896bff22fe72
 *
 * Zero LLM calls; 100% deterministic & unit-testable.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets");

export const JOURNAL_CONSTANTS = Object.freeze({
  title: "International Journal of Social Work and Development Studies",
  headerTitle: "International Journal Of Social Work and Development Studies (IJSDS)",
  abbreviation: "IJSDS",
  issnPrint: "3115-6940",
  issnOnline: "3115-6932",
  publisher: "Rivers State University",
  imprint: "PARAKLETUS PUBLISHING",
  website: "www.ijsds.org",
  editorialEmail: "editor@ijsds.org",
  gmailEditorial: "editor.ijsds@gmail.com",
  universityEmail: "dsw@ust.edu.ng",
  phone: "+234 808 022 4405",
  license: "Creative Commons Attribution 4.0 International (CC BY 4.0)",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  siteUrl: "https://www.ijsds.org",
});

export const ARCHIVE_TEMPLATE_PROVENANCE = Object.freeze({
  templateVersion: "2.0.0-archive-calibrated",
  sourceDoi: "10.67007/ijsds-2026-v2_i2_001",
  sourcePdfSha256: "6ad0434e3d936486a581c38198391050c80387139e136d9080a8896bff22fe72",
  assets: {
    frontCover: "cover-front-base.jpg",
    watermark: "watermark-emblem.jpg",
    backCover: "cover-back-base.jpg",
  },
});

const assetCache = new Map();
const loadAssetDataUri = (filename, mime = "image/jpeg") => {
  if (assetCache.has(filename)) return assetCache.get(filename);
  const fullPath = path.join(ASSETS_DIR, filename);
  try {
    const buf = fs.readFileSync(fullPath);
    const uri = `data:${mime};base64,${buf.toString("base64")}`;
    assetCache.set(filename, uri);
    return uri;
  } catch {
    return null;
  }
};

export const sha256Hex = (input) =>
  crypto.createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex");

const escapeHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeCssContent = (str) =>
  String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\A ");

const TITLE_PREFIX = /\b(?:Dr\.|Prof\.|Professor|Engr\.|Rev\.|Mr\.|Mrs\.|Ms\.)\s+/gi;
const DEGREE_SUFFIX = /(?:,\s*|\s+\()(?:PhD|Ph\.D\.|MSc|M\.Sc\.|BSc|B\.Sc\.|MD|Esq\.|BL)\)?/gi;

export const cleanAuthorName = (name) =>
  String(name ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(DEGREE_SUFFIX, "")
    .replace(TITLE_PREFIX, "")
    .replace(/\s+/g, " ")
    .replace(/[,\s]+$/, "")
    .trim();

export const normalizeOrcidUrl = (orcid) => {
  if (!orcid) return null;
  const clean = String(orcid).trim().replace(/^https?:\/\/orcid\.org\//i, "").trim();
  return /^\d{4}-\d{4}-\d{4}-[\dX]{4}$/.test(clean) ? `https://orcid.org/${clean}` : null;
};

const MAJOR_HEADING_RE = /^(?:\d+(?:\.0)?\.?\s+[A-Z0-9\s,&:-]{3,}|(?:INTRODUCTION|BACKGROUND(?:\s+OF\s+THE\s+STUDY)?|LITERATURE REVIEW|THEORETICAL FRAMEWORK|METHODOLOGY|METHODS|RESULTS|DISCUSSION|CONCLUSION|CONCLUSIONS|RECOMMENDATIONS|REFERENCES|ACKNOWLEDGEMENTS?|CONFLICT OF INTEREST|ETHICS STATEMENT|FUNDING))$/i;
const SUB_HEADING_RE = /^\d+\.\d+\.?\s+\S.{2,90}$/;
const TABLE_CAPTION_RE = /^Table\s+\d+\s*[:.-]/i;
const INTRO_HEADING_RE = /^(?:\d+(?:\.0)?\.?\s+)?(?:INTRODUCTION|BACKGROUND(?:\s+OF\s+THE\s+STUDY)?)\b/i;
const KEYWORDS_LINE_RE = /^Key\s*words?\s*:/i;
const ABSTRACT_HEADING_RE = /^ABSTRACT\s*:?$/i;

const classifyBodyParagraph = (text) => {
  if (text.length <= 95 && MAJOR_HEADING_RE.test(text)) return "heading";
  if (text.length <= 100 && SUB_HEADING_RE.test(text)) return "subheading";
  if (text.length <= 180 && TABLE_CAPTION_RE.test(text)) return "table_caption";
  // Detect unnumbered standalone Title-Case subheadings (e.g. "Objectives of the study",
  // "Advocacy and Policy Development") so they render bold and never orphan at column bottom.
  if (
    text.length >= 6 &&
    text.length <= 85 &&
    !/[.!?;:]$/.test(text) &&
    /^[A-Z]/.test(text) &&
    !/^(?:The|This|These|Those|In|On|At|For|From|With|According|However|Furthermore|Moreover|Finally|Table|Figure)\b/.test(text) &&
    text.split(/\s+/).length >= 2 &&
    text.split(/\s+/).length <= 12
  ) {
    return "subheading";
  }
  return "paragraph";
};

/**
 * Safely strips duplicate front-matter (title, author, affiliation, abstract, keywords)
 * that often appears at the top of uploaded `.docx` files before `1. INTRODUCTION`,
 * since Pages 3–4 already render verified title/authors/abstract/keywords from the DB.
 * Leaves manuscripts that already start with body content untouched.
 */
const stripDuplicateFrontMatter = (items, title = "") => {
  if (!Array.isArray(items) || items.length < 3) return items;
  const windowLimit = Math.min(items.length, 40);
  const normTitle = String(title ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let hasFrontMarker = false;
  let keywordsIdx = -1;
  let introIdx = -1;

  for (let i = 0; i < windowLimit; i++) {
    const it = items[i];
    if (!it || it.kind === "table") continue;
    const text = String(it.text ?? "").trim();
    if (!text) continue;

    if (ABSTRACT_HEADING_RE.test(text) || /^ABSTRACT\s*[:.-]\s+/i.test(text)) {
      hasFrontMarker = true;
    }
    if (KEYWORDS_LINE_RE.test(text)) {
      hasFrontMarker = true;
      keywordsIdx = i;
    }
    if (normTitle.length >= 12) {
      const normText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normText && (normText === normTitle || normText.includes(normTitle))) {
        hasFrontMarker = true;
      }
    }
    if (introIdx === -1 && text.length <= 95 && INTRO_HEADING_RE.test(text)) {
      introIdx = i;
      break;
    }
  }

  if (!hasFrontMarker) return items;
  if (introIdx > 0) return items.slice(introIdx);
  if (keywordsIdx >= 0 && keywordsIdx + 1 < items.length) {
    let start = keywordsIdx + 1;
    if (start < items.length && /^word\s+count\s*:/i.test(String(items[start]?.text ?? "").trim())) {
      start += 1;
    }
    return items.slice(start);
  }
  return items;
};

/**
 * Splits extracted manuscript text (or ordered structured `.docx` items) into immutable
 * anchored blocks (`p-001`, `tbl-01`, `ref-001`, ...).
 * Copyedit proposals reference these exact block IDs so unapproved text is never altered.
 * Optional `tables` array carries structured `{ caption, headers, rows }` blocks and is
 * anchored inline right after the first paragraph citing `Table N` (or at the end if unmentioned).
 */
export const buildCanonicalBlocks = ({
  title,
  abstract,
  bodyText = "",
  bodyItems = null,
  referencesText = "",
  tables = [],
}) => {
  const blocks = [];
  if (title) blocks.push({ blockId: "sec-title", section: "Title", kind: "title", text: String(title).trim() });
  if (abstract) blocks.push({ blockId: "sec-abstract", section: "Abstract", kind: "abstract", text: String(abstract).trim() });

  const makeTableBlock = (tbl, idx) => {
    const flatText = [
      tbl.caption ?? "",
      ...(tbl.headers ?? []),
      ...((tbl.rows ?? []).flat()),
    ]
      .filter(Boolean)
      .join(" ");
    return {
      blockId: `tbl-${String(idx).padStart(2, "0")}`,
      section: "Body",
      kind: "table",
      text: flatText,
      tableData: {
        caption: tbl.caption ?? "",
        headers: tbl.headers ?? [],
        rows: tbl.rows ?? [],
      },
    };
  };

  if (Array.isArray(bodyItems) && bodyItems.length > 0) {
    const cleanedItems = stripDuplicateFrontMatter(bodyItems, title);
    let pCount = 0;
    let tCount = 0;
    for (const item of cleanedItems) {
      if (item.kind === "table") {
        tCount += 1;
        blocks.push(makeTableBlock(item, tCount));
      } else {
        const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        pCount += 1;
        const kind =
          item.kind === "heading" || item.kind === "subheading"
            ? item.kind
            : classifyBodyParagraph(text);
        blocks.push({
          blockId: `p-${String(pCount).padStart(3, "0")}`,
          section: "Body",
          kind,
          text,
        });
      }
    }
  } else {
    const rawBodyParas = String(bodyText ?? "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 0);
    const bodyParas = stripDuplicateFrontMatter(
      rawBodyParas.map((text) => ({ kind: "paragraph", text })),
      title,
    ).map((it) => it.text);

    const pendingTables = (tables ?? []).map((tbl, idx) => {
      const markerMatch = String(tbl.caption ?? "").match(/\bTable\s+\d+\b/i);
      return { tbl, idx: idx + 1, marker: markerMatch ? markerMatch[0].toLowerCase() : null, placed: false };
    });

    bodyParas.forEach((text, i) => {
      blocks.push({
        blockId: `p-${String(i + 1).padStart(3, "0")}`,
        section: "Body",
        kind: classifyBodyParagraph(text),
        text,
      });
      const lower = text.toLowerCase();
      for (const entry of pendingTables) {
        if (!entry.placed && entry.marker && lower.includes(entry.marker)) {
          blocks.push(makeTableBlock(entry.tbl, entry.idx));
          entry.placed = true;
        }
      }
    });

    for (const entry of pendingTables) {
      if (!entry.placed) {
        blocks.push(makeTableBlock(entry.tbl, entry.idx));
      }
    }
  }

  const refLines = String(referencesText ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((r) => r.trim())
    .filter((r) => r.length > 10);

  refLines.forEach((text, i) => {
    blocks.push({
      blockId: `ref-${String(i + 1).padStart(3, "0")}`,
      section: "References",
      kind: "reference",
      text,
    });
  });

  return blocks;
};

/**
 * Deterministically applies ONLY human-accepted copyedit proposals whose `original_quote`
 * still matches the anchored block. Pending or rejected proposals are never applied.
 */
export const applyAcceptedProposals = (blocks, proposals) => {
  const acceptedByBlock = new Map();
  for (const p of proposals ?? []) {
    if (p.status !== "accepted") continue;
    const list = acceptedByBlock.get(p.block_id ?? p.blockId) ?? [];
    list.push(p);
    acceptedByBlock.set(p.block_id ?? p.blockId, list);
  }

  return blocks.map((block) => {
    const edits = acceptedByBlock.get(block.blockId);
    if (!edits || edits.length === 0) return { ...block };
    let nextText = block.text;
    for (const edit of edits) {
      const orig = edit.original_quote ?? edit.originalQuote ?? "";
      const prop = edit.proposed_text ?? edit.proposedText ?? "";
      if (orig && nextText.includes(orig)) {
        nextText = nextText.replace(orig, prop);
      }
    }
    return { ...block, text: nextText };
  });
};

const extractSignificantNumbers = (text) => {
  const matches = String(text ?? "").match(/\b\d+(?:[.,]\d+)?(?:%|\b)/g) ?? [];
  return [...new Set(matches.filter((n) => n.length >= 2 || n.includes(".") || n.includes("%")))];
};

const extractTableFigureMarkers = (text) => {
  const matches = String(text ?? "").match(/\b(?:Table|Figure|Fig\.)\s+\d+\b/gi) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\s+/g, " ").trim()))];
};

const tokenizeWords = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * PRD v2.4.2-PROD D02 — Deterministic Content Preservation Gate.
 * Reconciles rendered PDF/JATS extracted text against the locked approved copyedit source
 * and verifies that dynamic Volume/Issue/DOI/ISSN metadata rendered accurately.
 */
export const verifyContentPreservation = ({
  approvedCopyeditHash,
  canonicalBlocks,
  renderedPlainText,
  expectedMetadata = {},
}) => {
  const nonBodyBlocks = canonicalBlocks.filter((b) => b.section !== "Body");
  const cleanedBodyBlocks = stripDuplicateFrontMatter(
    canonicalBlocks.filter((b) => b.section === "Body"),
    expectedMetadata.title ?? "",
  );
  const effectiveBlocks = [...nonBodyBlocks, ...cleanedBodyBlocks];
  const canonicalText = effectiveBlocks.map((b) => b.text).join("\n");
  const renderedLower = String(renderedPlainText ?? "").toLowerCase();
  const compactRendered = renderedLower.replace(/\s+/g, "");

  // 1. Word-multiset coverage ratio (order-tolerant to 2-column reflow, strict on dropped words)
  const expectedWords = tokenizeWords(canonicalText);
  const renderedCounts = new Map();
  for (const w of tokenizeWords(renderedPlainText)) {
    renderedCounts.set(w, (renderedCounts.get(w) ?? 0) + 1);
  }
  let matched = 0;
  for (const w of expectedWords) {
    const count = renderedCounts.get(w) ?? 0;
    if (count > 0) {
      matched += 1;
      renderedCounts.set(w, count - 1);
    }
  }
  const extractedTextMatchRatio = expectedWords.length ? Number((matched / expectedWords.length).toFixed(4)) : 1;

  // 2. Numeric & statistical value preservation (tolerate PDF spacing inside numbers/percent)
  const missingNumbers = extractSignificantNumbers(canonicalText).filter(
    (num) => !String(renderedPlainText ?? "").includes(num) && !compactRendered.includes(num.toLowerCase()),
  );

  // 3. Table / Figure caption marker preservation
  const missingTablesOrFigures = extractTableFigureMarkers(canonicalText).filter(
    (marker) => !renderedLower.includes(marker.toLowerCase()),
  );

  // 4. Reference preservation (verify first 6 significant tokens of each reference block)
  const refBlocks = canonicalBlocks.filter((b) => b.section === "References");
  const renderedWordJoined = tokenizeWords(renderedPlainText).join(" ");
  const missingReferences = refBlocks
    .filter((r) => {
      const probe = tokenizeWords(r.text).slice(0, 6).join(" ");
      return probe.length > 8 && !renderedWordJoined.includes(probe);
    })
    .map((r) => r.blockId);

  // 5. Verified dynamic metadata preservation (title, DOI, ISSNs, Volume, Issue)
  const metadataMismatchFields = [];
  if (expectedMetadata.doi) {
    const compactDoi = String(expectedMetadata.doi).replace(/\s+/g, "").toLowerCase();
    if (!compactRendered.includes(compactDoi)) metadataMismatchFields.push("doi");
  }
  if (expectedMetadata.title) {
    const titleProbe = tokenizeWords(expectedMetadata.title).slice(0, 6).join(" ");
    if (titleProbe && !renderedWordJoined.includes(titleProbe)) {
      metadataMismatchFields.push("title");
    }
  }
  if (expectedMetadata.issnOnline) {
    const compactIssn = String(expectedMetadata.issnOnline).replace(/\s+/g, "").toLowerCase();
    if (!compactRendered.includes(compactIssn)) metadataMismatchFields.push("issnOnline");
  }
  if (expectedMetadata.volume && expectedMetadata.issue) {
    const volIssCompact = `vol${expectedMetadata.volume}issue${expectedMetadata.issue}`;
    const volDotIssCompact = `vol.${expectedMetadata.volume}.issue${expectedMetadata.issue}`;
    const fullVolIssCompact = `volume${expectedMetadata.volume}issue${expectedMetadata.issue}`;
    if (
      !compactRendered.includes(volIssCompact) &&
      !compactRendered.includes(volDotIssCompact) &&
      !compactRendered.includes(fullVolIssCompact)
    ) {
      metadataMismatchFields.push("volume_issue");
    }
  }

  const passed =
    extractedTextMatchRatio >= 0.985 &&
    missingNumbers.length === 0 &&
    missingReferences.length === 0 &&
    missingTablesOrFigures.length === 0 &&
    metadataMismatchFields.length === 0;

  return {
    passed,
    approvedCopyeditHash,
    extractedTextMatchRatio,
    missingNumbers,
    missingReferences,
    missingTablesOrFigures,
    metadataMismatchFields,
  };
};

/**
 * Generates JATS 1.3 XML from verified database metadata and locked canonical blocks.
 */
export const generateJatsXml = ({ article, blocks }) => {
  const pubDate = article.publication_date ? new Date(article.publication_date) : new Date();
  const year = Number.isNaN(pubDate.getTime()) ? new Date().getFullYear() : pubDate.getFullYear();
  const month = Number.isNaN(pubDate.getTime()) ? new Date().getMonth() + 1 : pubDate.getMonth() + 1;
  const day = Number.isNaN(pubDate.getTime()) ? new Date().getDate() : pubDate.getDate();
  const doi = article.crossrefDoi || article.doi || null;
  const authors = Array.isArray(article.authors) ? article.authors : [];

  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("article", {
    "xmlns:xlink": "http://www.w3.org/1999/xlink",
    "article-type": "research-article",
    "dtd-version": "1.3",
    "xml:lang": "en",
  });

  const front = root.ele("front");
  const jMeta = front.ele("journal-meta");
  jMeta.ele("journal-id", { "journal-id-type": "publisher-id" }).txt(JOURNAL_CONSTANTS.abbreviation);
  jMeta.ele("journal-title-group").ele("journal-title").txt(JOURNAL_CONSTANTS.title);
  jMeta.ele("issn", { "pub-type": "ppub" }).txt(JOURNAL_CONSTANTS.issnPrint);
  jMeta.ele("issn", { "pub-type": "epub" }).txt(JOURNAL_CONSTANTS.issnOnline);
  jMeta.ele("publisher").ele("publisher-name").txt(JOURNAL_CONSTANTS.publisher);

  const aMeta = front.ele("article-meta");
  if (doi) aMeta.ele("article-id", { "pub-id-type": "doi" }).txt(doi);
  aMeta.ele("article-id", { "pub-id-type": "publisher-id" }).txt(article.id);
  aMeta.ele("title-group").ele("article-title").txt(article.title ?? "");

  const contribGroup = aMeta.ele("contrib-group");
  authors.forEach((a, idx) => {
    const cleaned = cleanAuthorName(a?.name ?? "");
    if (!cleaned) return;
    const parts = cleaned.split(/\s+/);
    const surname = parts.length > 1 ? parts[parts.length - 1] : cleaned;
    const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
    const contrib = contribGroup.ele("contrib", { "contrib-type": "author" });
    const orcidUrl = normalizeOrcidUrl(a?.orcid);
    if (orcidUrl) contrib.ele("contrib-id", { "contrib-id-type": "orcid" }).txt(orcidUrl);
    const nameEl = contrib.ele("name");
    nameEl.ele("surname").txt(surname);
    if (given) nameEl.ele("given-names").txt(given);
    if (a?.affiliation) contrib.ele("xref", { "ref-type": "aff", rid: `aff-${idx + 1}` }).txt(String(idx + 1));
  });
  authors.forEach((a, idx) => {
    if (a?.affiliation) {
      contribGroup.ele("aff", { id: `aff-${idx + 1}` }).txt(String(a.affiliation).trim());
    }
  });

  const pDate = aMeta.ele("pub-date", { "pub-type": "epub" });
  pDate.ele("day").txt(String(day).padStart(2, "0"));
  pDate.ele("month").txt(String(month).padStart(2, "0"));
  pDate.ele("year").txt(String(year));
  if (article.volume) aMeta.ele("volume").txt(String(article.volume));
  if (article.issue) aMeta.ele("issue").txt(String(article.issue));
  if (article.page_start) aMeta.ele("fpage").txt(String(article.page_start));
  if (article.page_end) aMeta.ele("lpage").txt(String(article.page_end));

  const perms = aMeta.ele("permissions");
  perms.ele("copyright-statement").txt(`© ${year} The Author(s).`);
  perms.ele("copyright-year").txt(String(year));
  const lic = perms.ele("license", { "license-type": "open-access", "xlink:href": JOURNAL_CONSTANTS.licenseUrl });
  lic.ele("license-p").txt(`This article is distributed under the terms of ${JOURNAL_CONSTANTS.license}.`);

  const absBlock = blocks.find((b) => b.blockId === "sec-abstract")?.text ?? article.abstract ?? "";
  if (absBlock) aMeta.ele("abstract").ele("p").txt(absBlock);

  if (Array.isArray(article.keywords) && article.keywords.length > 0) {
    const kwdGroup = aMeta.ele("kwd-group");
    article.keywords.filter(Boolean).forEach((k) => kwdGroup.ele("kwd").txt(String(k).trim()));
  }

  const body = root.ele("body");
  blocks
    .filter((b) => b.section === "Body")
    .forEach((b) => body.ele("p", { id: b.blockId }).txt(b.text));

  const refs = blocks.filter((b) => b.section === "References");
  if (refs.length > 0) {
    const refList = root.ele("back").ele("ref-list");
    refList.ele("title").txt("References");
    refs.forEach((r) => refList.ele("ref", { id: r.blockId }).ele("mixed-citation").txt(r.text));
  }

  return root.end({ prettyPrint: true });
};

const formatTableCellHtml = (cell) =>
  escapeHtml(cell).replace(/\n/g, "<br />");

const renderBodyBlock = (b) => {
  if (b.kind === "table" && b.tableData) {
    const caption = b.tableData.caption
      ? `<p class="table-caption">${escapeHtml(b.tableData.caption)}</p>`
      : "";
    const headCells = (b.tableData.headers ?? []).map((h) => `<th>${formatTableCellHtml(h)}</th>`).join("");
    const bodyRows = (b.tableData.rows ?? [])
      .map((row) => `<tr>${row.map((cell) => `<td>${formatTableCellHtml(cell)}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="table-wrap" data-block="${escapeHtml(b.blockId)}">${caption}<table class="ijsds-table"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  }
  if (b.kind === "heading") {
    return `<h2 class="sec-heading" data-block="${escapeHtml(b.blockId)}">${escapeHtml(b.text)}</h2>`;
  }
  if (b.kind === "subheading") {
    return `<h3 class="sub-heading" data-block="${escapeHtml(b.blockId)}">${escapeHtml(b.text)}</h3>`;
  }
  if (b.kind === "table_caption") {
    return `<p class="table-caption full-span" data-block="${escapeHtml(b.blockId)}">${escapeHtml(b.text)}</p>`;
  }
  return `<p class="body-p" data-block="${escapeHtml(b.blockId)}">${escapeHtml(b.text)}</p>`;
};

/**
 * Archive-calibrated deterministic IJSDS Paged-Media HTML generator (zero scripts, zero external URLs).
 * Faithfully reproduces the live IJSDS issue layout:
 *  - Page 1: Full-bleed front cover with dynamically injected `Volume {V} Issue {I}`
 *  - Page 2: Inside title page (`ii`) with dynamic `Vol {V} Issue {I}` & editorial contacts
 *  - Page 3: Centered ALL-CAPS article title, authors, affiliations, emails, ORCIDs, DOI (`1`)
 *  - Page 4: Single-column justified Abstract & Keywords (`2`)
 *  - Pages 5+: Two-column justified Times New Roman body, full-width bordered tables,
 *              and two-column hanging-indent APA 7th References (`3+`)
 *  - Final Page: Full-bleed official IJSDS back cover
 *  - Dynamic running headers (`Vol. {V}. Issue {I}.`, `ISSN: 3115-6940`, `EISSN: 3115-6932`)
 *    and centered twin-figures watermark on every interior page.
 */
export const renderPublicationHtml = ({ article, blocks }) => {
  const pubDate = article.publication_date ? new Date(article.publication_date) : new Date();
  const year = Number.isNaN(pubDate.getTime()) ? new Date().getFullYear() : pubDate.getFullYear();
  const doi = article.crossrefDoi || article.doi || null;
  const volume = article.volume ?? Math.max(1, year - 2024);
  const issue = article.issue ?? pubDate.getMonth() + 1;

  const volIssueCover = `Volume ${volume} Issue ${issue}`;
  const volIssueInside = `Vol ${volume} Issue ${issue}`;
  const volIssueHeader = `Vol. ${volume}. Issue ${issue}.`;
  const parsedStartPage = Number.parseInt(article.page_start, 10);
  const folioResetBase = Number.isFinite(parsedStartPage) && parsedStartPage > 1 ? parsedStartPage - 1 : 0;

  const frontCoverUri = loadAssetDataUri(ARCHIVE_TEMPLATE_PROVENANCE.assets.frontCover);
  const watermarkUri = loadAssetDataUri(ARCHIVE_TEMPLATE_PROVENANCE.assets.watermark);
  const backCoverUri = loadAssetDataUri(ARCHIVE_TEMPLATE_PROVENANCE.assets.backCover);
  const serifRegUri = loadAssetDataUri("fonts/LiberationSerif-Regular.ttf", "font/ttf");
  const serifBoldUri = loadAssetDataUri("fonts/LiberationSerif-Bold.ttf", "font/ttf");
  const serifItalicUri = loadAssetDataUri("fonts/LiberationSerif-Italic.ttf", "font/ttf");
  const fontFaceCss = [
    serifRegUri
      ? `@font-face { font-family: "IJSDS Serif"; src: url("${serifRegUri}") format("truetype"); font-weight: 400; font-style: normal; }`
      : "",
    serifBoldUri
      ? `@font-face { font-family: "IJSDS Serif"; src: url("${serifBoldUri}") format("truetype"); font-weight: 700; font-style: normal; }`
      : "",
    serifItalicUri
      ? `@font-face { font-family: "IJSDS Serif"; src: url("${serifItalicUri}") format("truetype"); font-weight: 400; font-style: italic; }`
      : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  const authors = Array.isArray(article.authors) ? article.authors : [];
  const keywords = Array.isArray(article.keywords) ? article.keywords.filter(Boolean) : [];
  const abstractText = blocks.find((b) => b.blockId === "sec-abstract")?.text ?? article.abstract ?? "";

  // Author line: "Author One¹, Author Two² & Author Three³"
  const authorLineHtml = authors
    .map((a, idx) => {
      const displayName = escapeHtml(String(a?.name ?? "").trim());
      if (!displayName) return "";
      const sep = idx === 0 ? "" : idx === authors.length - 1 ? " &amp; " : ", ";
      return `${sep}<strong>${displayName}<sup>${idx + 1}</sup></strong>`;
    })
    .filter(Boolean)
    .join("");

  const affiliationsHtml = authors
    .map((a, idx) =>
      a?.affiliation ? `<p class="aff-line"><sup>${idx + 1}</sup>${escapeHtml(a.affiliation)}</p>` : "",
    )
    .filter(Boolean)
    .join("\n");

  const emailsOrcidHtml = authors
    .map((a, idx) => {
      const email = a?.email ? `<em><sup>${idx + 1}</sup>${escapeHtml(a.email)}</em>` : "";
      const orcid = normalizeOrcidUrl(a?.orcid);
      const orcidHtml = orcid
        ? ` <span class="orcid-inline">(<a href="${escapeHtml(orcid)}">${escapeHtml(orcid)}</a>)</span>`
        : "";
      return email || orcidHtml ? `<p class="email-line">${email}${orcidHtml}</p>` : "";
    })
    .filter(Boolean)
    .join("\n");

  const correspondingEmail = article.corresponding_author_email || authors[0]?.email || null;

  const bodyBlocks = stripDuplicateFrontMatter(
    blocks.filter((b) => b.section === "Body"),
    article.title,
  );
  const bodyHtml = bodyBlocks.map(renderBodyBlock).join("\n");

  const refBlocks = blocks.filter((b) => b.section === "References");
  const refsHtml = refBlocks
    .map((r) => `<p class="ref-item" data-block="${escapeHtml(r.blockId)}">${escapeHtml(r.text)}</p>`)
    .join("\n");

  const headerLeftCss = escapeCssContent(
    `${JOURNAL_CONSTANTS.headerTitle}\n${JOURNAL_CONSTANTS.website} || ${JOURNAL_CONSTANTS.gmailEditorial}`,
  );
  const headerRightCss = escapeCssContent(
    `${volIssueHeader}\nISSN: ${JOURNAL_CONSTANTS.issnPrint}\nEISSN: ${JOURNAL_CONSTANTS.issnOnline}`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(article.title)} — ${escapeHtml(JOURNAL_CONSTANTS.abbreviation)}</title>
  <style>
    ${fontFaceCss}
    @page {
      size: A4;
      margin: 24mm 18mm 20mm 18mm;
      counter-increment: folio 1;
      @top-left {
        content: "${headerLeftCss}";
        white-space: pre-line;
        font-family: "Times New Roman", "IJSDS Serif", Times, Georgia, serif;
        font-size: 8.5pt;
        line-height: 1.3;
        color: #111111;
        vertical-align: bottom;
        padding-bottom: 5mm;
      }
      @top-right {
        content: "${headerRightCss}";
        white-space: pre-line;
        text-align: right;
        font-family: "Times New Roman", Times, Georgia, serif;
        font-size: 8.5pt;
        line-height: 1.3;
        color: #111111;
        vertical-align: bottom;
        padding-bottom: 5mm;
      }
      @bottom-center {
        content: counter(folio);
        font-family: "Times New Roman", Times, Georgia, serif;
        font-size: 10pt;
        color: #111111;
        vertical-align: top;
        padding-top: 4mm;
      }
    }

    @page cover {
      margin: 0;
      counter-reset: folio ${folioResetBase};
      counter-increment: none;
      @top-left { content: none; }
      @top-right { content: none; }
      @bottom-center { content: none; }
    }

    @page inside {
      margin: 24mm 18mm 20mm 18mm;
      counter-reset: folio ${folioResetBase};
      counter-increment: none;
      @bottom-center {
        content: "ii";
        font-family: "Times New Roman", Times, Georgia, serif;
        font-size: 10pt;
        color: #111111;
        vertical-align: top;
        padding-top: 4mm;
      }
    }

    @page backcover {
      margin: 0;
      counter-increment: none;
      @top-left { content: none; }
      @top-right { content: none; }
      @bottom-center { content: none; }
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #000000;
      font-family: "Times New Roman", "IJSDS Serif", Times, Georgia, serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* Subtle centered twin-figures emblem watermark on interior pages */
    .watermark-bg {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 116mm;
      opacity: 0.068;
      z-index: 0;
      pointer-events: none;
    }

    /* ── Page 1: Full-Bleed Official Front Cover ── */
    .page-cover {
      page: cover;
      position: relative;
      width: 210mm;
      height: 297mm;
      overflow: hidden;
      background: #f3f4f6;
      break-after: page;
      z-index: 2;
    }
    .cover-img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .cover-vol-badge {
      position: absolute;
      top: 16mm;
      left: 84mm;
      width: 72mm;
      height: 13.5mm;
      background: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Impact, "Arial Narrow", "Liberation Sans Narrow", "Arial Black", Arial, sans-serif;
      font-weight: 800;
      font-size: 19pt;
      letter-spacing: 0.015em;
      color: #050b16;
    }

    /* ── Page 2: Inside Journal Title Page (ii) ── */
    .page-inside {
      page: inside;
      position: relative;
      z-index: 1;
      height: 250mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      break-after: page;
    }
    .inside-journal-title {
      font-size: 22pt;
      font-weight: 700;
      line-height: 1.3;
      margin: 0 0 6mm;
    }
    .inside-vol-issue {
      font-size: 19pt;
      font-weight: 400;
      margin: 0 0 42mm;
    }
    .inside-contacts {
      font-size: 13pt;
      font-weight: 700;
      line-height: 1.65;
    }
    .inside-contacts p { margin: 0; }
    .inside-contacts .u { text-decoration: underline; }

    /* ── Page 3: Article Title & Author Metadata (Page 1) ── */
    .article-pages {
      counter-reset: page 1;
      position: relative;
      z-index: 1;
    }
    .page-article-title {
      min-height: 245mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 6mm;
      break-after: page;
    }
    .article-main-title {
      font-size: 13.5pt;
      font-weight: 700;
      text-transform: uppercase;
      line-height: 1.75;
      letter-spacing: 0.01em;
      margin: 0 0 26mm;
      max-width: 160mm;
    }
    .author-line {
      font-size: 12pt;
      line-height: 1.5;
      margin: 0 0 4mm;
    }
    .aff-line {
      font-size: 11pt;
      line-height: 1.55;
      margin: 0 0 1.5mm;
    }
    .email-line {
      font-size: 10.5pt;
      line-height: 1.5;
      margin: 0 0 1.5mm;
    }
    .orcid-inline {
      font-style: normal;
      font-size: 9pt;
      color: #1a4e8a;
    }
    .orcid-inline a { color: #1a4e8a; text-decoration: none; }
    .corresp-line {
      font-size: 10.5pt;
      margin: 3mm 0 0;
    }
    .doi-meta-line {
      margin-top: 8mm;
      font-size: 9.5pt;
      color: #222222;
    }
    .doi-meta-line a { color: #1a4e8a; text-decoration: underline; }
    .oa-license-note {
      margin-top: 4mm;
      font-size: 8.5pt;
      color: #444444;
    }

    /* ── Page 4: Single-Column Abstract & Keywords (Page 2) ── */
    .page-abstract {
      break-after: page;
      padding-top: 2mm;
    }
    .abstract-heading {
      font-size: 11.5pt;
      font-weight: 700;
      text-transform: uppercase;
      margin: 0 0 5mm;
    }
    .abstract-body {
      font-size: 11.5pt;
      line-height: 1.65;
      text-align: justify;
      hyphens: auto;
      margin: 0 0 10mm;
    }
    .keywords-line {
      font-size: 11pt;
      line-height: 1.55;
      margin: 0;
    }

    /* ── Pages 5+: Two-Column Justified Academic Body & Full-Width Tables ── */
    .body-two-col {
      column-count: 2;
      column-gap: 7.5mm;
      font-size: 10.5pt;
      line-height: 1.55;
      text-align: justify;
      hyphens: auto;
      overflow-wrap: break-word;
    }
    .sec-heading {
      font-size: 10.5pt;
      font-weight: 700;
      text-transform: uppercase;
      margin: 4mm 0 2.5mm;
      break-after: avoid;
      text-align: left;
    }
    .sub-heading {
      font-size: 10.5pt;
      font-weight: 700;
      margin: 3.5mm 0 2mm;
      break-after: avoid;
      text-align: left;
    }
    .body-p {
      margin: 0 0 3.2mm;
      orphans: 3;
      widows: 3;
    }
    .full-span,
    .table-wrap {
      column-span: all;
      break-inside: avoid;
      margin: 4mm 0 5mm;
    }
    .table-caption {
      font-size: 10pt;
      font-weight: 400;
      margin: 0 0 2mm;
      text-align: left;
    }
    .ijsds-table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      font-size: 9.5pt;
      line-height: 1.35;
      text-align: left;
    }
    .ijsds-table th,
    .ijsds-table td {
      border: 0.75pt solid #000000;
      padding: 2mm 2.5mm;
      vertical-align: top;
    }
    .ijsds-table th {
      font-weight: 700;
      text-transform: uppercase;
      background: #ffffff;
    }

    /* ── References: Two-Column Hanging-Indent APA 7th ── */
    .refs-section {
      margin-top: 6mm;
      column-count: 2;
      column-gap: 7.5mm;
      font-size: 10pt;
      line-height: 1.48;
      text-align: left;
      hyphens: auto;
    }
    .refs-heading {
      column-span: all;
      font-size: 10.5pt;
      font-weight: 700;
      text-transform: uppercase;
      margin: 0 0 3.5mm;
      break-after: avoid;
    }
    .ref-item {
      margin: 0 0 2.8mm;
      padding-left: 7mm;
      text-indent: -7mm;
      break-inside: avoid;
    }

    /* ── Final Page: Full-Bleed Official Back Cover ── */
    .page-backcover {
      page: backcover;
      position: relative;
      width: 210mm;
      height: 297mm;
      overflow: hidden;
      background: #f4f5f7;
      break-before: page;
      z-index: 2;
    }
    .backcover-footer-text {
      position: absolute;
      left: 0;
      right: 0;
      top: 224mm;
      text-align: center;
      font-family: Arial, Helvetica, sans-serif;
      font-weight: 700;
      font-size: 9pt;
      line-height: 1.6;
      color: #0b1a33;
      letter-spacing: 0.03em;
    }
    .backcover-footer-text p { margin: 0; }
    .backcover-footer-text .contact-label { margin-top: 3mm; }
  </style>
</head>
<body>
  ${watermarkUri ? `<img class="watermark-bg" src="${watermarkUri}" alt="" />` : ""}

  <!-- Page 1: Official Full-Bleed Front Cover with dynamic Volume & Issue -->
  <section class="page-cover">
    ${frontCoverUri ? `<img class="cover-img" src="${frontCoverUri}" alt="IJSDS Cover" />` : ""}
    <div class="cover-vol-badge">${escapeHtml(volIssueCover)}</div>
  </section>

  <!-- Page 2: Inside Journal Title Page (ii) -->
  <section class="page-inside">
    <p class="inside-journal-title">
      International Journal<br />
      of Social Work<br />
      and Development Studies (IJSDS)
    </p>
    <p class="inside-vol-issue">${escapeHtml(volIssueInside)}</p>
    <div class="inside-contacts">
      <p class="u">${escapeHtml(JOURNAL_CONSTANTS.editorialEmail)}</p>
      <p class="u">${escapeHtml(JOURNAL_CONSTANTS.website)}</p>
      <p class="u">${escapeHtml(JOURNAL_CONSTANTS.gmailEditorial)}</p>
      <p>${escapeHtml(JOURNAL_CONSTANTS.phone)}</p>
    </div>
  </section>

  <!-- Pages 3+: Article Content (numbered starting at 1) -->
  <div class="article-pages">
    <section class="page-article-title">
      <h1 class="article-main-title">${escapeHtml(article.title)}</h1>
      ${authorLineHtml ? `<p class="author-line">${authorLineHtml}</p>` : ""}
      ${affiliationsHtml}
      ${emailsOrcidHtml}
      ${correspondingEmail ? `<p class="corresp-line">Corresponding author: <em>${escapeHtml(correspondingEmail)}</em></p>` : ""}
      ${doi ? `<p class="doi-meta-line">DOI: <a href="https://doi.org/${escapeHtml(doi)}">https://doi.org/${escapeHtml(doi)}</a></p>` : ""}
      <p class="oa-license-note">© ${year} The Author(s). Open Access under ${escapeHtml(JOURNAL_CONSTANTS.license)} · ISSN ${JOURNAL_CONSTANTS.issnPrint} | eISSN ${JOURNAL_CONSTANTS.issnOnline}</p>
    </section>

    <section class="page-abstract">
      <h2 class="abstract-heading">ABSTRACT</h2>
      <p class="abstract-body">${escapeHtml(abstractText)}</p>
      ${keywords.length ? `<p class="keywords-line"><strong>Keywords:</strong> ${escapeHtml(keywords.join(", "))}</p>` : ""}
    </section>

    <main class="body-two-col">
      ${bodyHtml}
    </main>

    ${refsHtml ? `<section class="refs-section"><h2 class="refs-heading">REFERENCES</h2>${refsHtml}</section>` : ""}
  </div>

  <!-- Final Page: Official Full-Bleed Back Cover -->
  <section class="page-backcover">
    ${backCoverUri ? `<img class="cover-img" src="${backCoverUri}" alt="IJSDS Back Cover" />` : ""}
    <div class="backcover-footer-text">
      <p>PUBLISHED BY ${escapeHtml(JOURNAL_CONSTANTS.imprint)}</p>
      <p class="contact-label">CONTACT THE UNIVERSITY @<br />${escapeHtml(JOURNAL_CONSTANTS.universityEmail)}</p>
    </div>
  </section>
</body>
</html>`;
};
