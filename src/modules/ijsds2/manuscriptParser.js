import mammoth from "mammoth";

// Stage 1: ingestion & text parsing. Pulls the manuscript file, extracts plain text and
// splits references. pdf-parse is loaded lazily (CJS, debug-mode side effects on import).

const REF_HEADING = /\n\s*(?:references|bibliography|works\s+cited)\s*\n/i;

/** A manuscript file that can't be turned into text. Retrying won't help: send it to an editor. */
export class UnreadableManuscriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnreadableManuscriptError";
  }
}

export const fetchFileBuffer = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Could not download manuscript (${res.status})`); // may be transient
  return Buffer.from(await res.arrayBuffer());
};

// Current pdf.js: rebuilds damaged cross-reference tables ("bad XRef entry") that the very old
// pdf.js bundled in pdf-parse gives up on.
const pdfjsText = async (buffer) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      // keep line breaks so headings like "References" stay on their own line
      pages.push(content.items.map((i) => (i.hasEOL ? `${i.str}\n` : i.str)).join(" "));
    }
    return pages.join("\n");
  } finally {
    await doc.destroy().catch(() => {});
  }
};

export const extractText = async (buffer, urlOrName = "") => {
  const lower = urlOrName.split("?")[0].toLowerCase();
  if (lower.endsWith(".pdf")) {
    const errors = [];
    try {
      return await pdfjsText(buffer);
    } catch (e) {
      errors.push(`pdf.js: ${e.message}`);
    }
    try {
      const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
      return (await pdfParse(buffer)).text;
    } catch (e) {
      errors.push(`pdf-parse: ${e.message}`);
    }
    throw new UnreadableManuscriptError(`The PDF could not be read (it may be damaged, scanned or password-protected): ${errors.join("; ")}`);
  }
  if (lower.endsWith(".docx")) {
    try {
      return (await mammoth.extractRawText({ buffer })).value;
    } catch (e) {
      throw new UnreadableManuscriptError(`The Word file could not be read: ${e.message}`);
    }
  }
  throw new UnreadableManuscriptError("Unsupported manuscript format for automated parsing (need .pdf or .docx)");
};

export const parseManuscriptText = (text) => {
  const normalized = text.replace(/\r\n/g, "\n");
  const refMatch = normalized.match(REF_HEADING);
  const body = refMatch ? normalized.slice(0, refMatch.index) : normalized;
  const refsText = refMatch ? normalized.slice(refMatch.index + refMatch[0].length) : "";
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  return {
    full_text: normalized,
    body_text: body,
    references_text: refsText,
    word_count: wordCount,
    char_count: normalized.length,
    has_references_heading: Boolean(refMatch),
  };
};

const decodeHtmlEntities = (str) =>
  String(str ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

const stripHtmlTags = (html) =>
  decodeHtmlEntities(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const stripCellHtmlPreservingLines = (html) =>
  decodeHtmlEntities(
    String(html ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

const REF_SECTION_LABEL = /^(?:references|bibliography|works\s+cited)$/i;
const TABLE_CAPTION_PREFIX = /^Table\s+\d+\s*[:.-]/i;

/**
 * Pure deterministic parser converting Mammoth HTML (from `.docx`) into ordered
 * `bodyItems` (headings, subheadings, paragraphs, and full structured tables)
 * plus a separate `references_text` block so Word tables render crisply without
 * being flattened into plain lines.
 */
export const parseHtmlToStructuredManuscript = (html) => {
  const source = String(html ?? "");
  const tokenRe = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const bodyItems = [];
  const refLines = [];
  let inReferences = false;

  for (const match of source.matchAll(tokenRe)) {
    const tag = match[1].toLowerCase();
    const inner = match[2];

    if (tag === "table") {
      const rowMatches = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
      const parsedRows = rowMatches
        .map((rm) =>
          [...rm[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cm) =>
            stripCellHtmlPreservingLines(cm[2]),
          ),
        )
        .filter((r) => r.some((cell) => cell.length > 0));

      if (parsedRows.length === 0) continue;

      let caption = "";
      const prev = bodyItems[bodyItems.length - 1];
      if (prev && prev.kind !== "table" && TABLE_CAPTION_PREFIX.test(prev.text)) {
        caption = prev.text;
        bodyItems.pop();
      }

      const headers = parsedRows[0];
      const rows = parsedRows.slice(1);
      bodyItems.push({ kind: "table", caption, headers, rows });
      continue;
    }

    const text = stripHtmlTags(inner);
    if (!text) continue;

    if (REF_SECTION_LABEL.test(text)) {
      inReferences = true;
      continue;
    }

    if (inReferences) {
      if (text.length > 10) refLines.push(text);
      continue;
    }

    if (tag === "h1" || tag === "h2") {
      bodyItems.push({ kind: "heading", text });
    } else if (tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
      bodyItems.push({ kind: "subheading", text });
    } else {
      bodyItems.push({ kind: "paragraph", text });
    }
  }

  return {
    body_items: bodyItems,
    references_text: refLines.join("\n"),
    table_count: bodyItems.filter((i) => i.kind === "table").length,
  };
};

/**
 * Extracts structured headings, paragraphs, tables, and references from a `.docx` buffer.
 */
export const extractDocxStructured = async (buffer) => {
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    return parseHtmlToStructuredManuscript(html);
  } catch (e) {
    throw new UnreadableManuscriptError(`The Word file could not be read: ${e.message}`);
  }
};
