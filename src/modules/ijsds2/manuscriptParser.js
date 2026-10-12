import mammoth from "mammoth";

// Stage 1: ingestion & text parsing. Pulls the manuscript file, extracts plain text and
// splits references. pdf-parse is loaded lazily (CJS, debug-mode side effects on import).

const REF_HEADING = /\n\s*(?:references|bibliography|works\s+cited)\s*\n/i;

export const fetchFileBuffer = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download manuscript (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

export const extractText = async (buffer, urlOrName = "") => {
  const lower = urlOrName.split("?")[0].toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    return (await pdfParse(buffer)).text;
  }
  if (lower.endsWith(".docx")) {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  throw new Error("Unsupported manuscript format for automated parsing (need .pdf or .docx)");
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
