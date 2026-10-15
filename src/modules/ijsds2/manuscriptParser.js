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
