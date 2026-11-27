import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { invokeStructuredTask } from "./aiGateway.service.js";

const execFileAsync = promisify(execFile);

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN || "/usr/bin/pdftoppm";

const findExecutable = async (candidates) => {
  for (const bin of candidates) {
    try {
      await fs.access(bin, fs.constants.X_OK);
      return bin;
    } catch {
      // try next candidate
    }
  }
  return null;
};

const renderWithPuppeteerChromium = async (html) => {
  const [pupMod, chromMod] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
  ]);
  const puppeteer = pupMod.default ?? pupMod;
  const chromium = chromMod.default ?? chromMod;
  const executablePath = await chromium.executablePath();
  if (!executablePath) return null;

  const browser = await puppeteer.launch({
    args: [
      ...(Array.isArray(chromium.args) ? chromium.args : []),
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: chromium.defaultViewport ?? { width: 1240, height: 1754 },
    executablePath,
    headless: chromium.headless ?? true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 45_000 });
    const pdfUint8 = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pdfBuffer = Buffer.from(pdfUint8);
    if (!pdfBuffer || pdfBuffer.length < 200) {
      throw new Error("Puppeteer PDF buffer is unexpectedly empty");
    }
    return { pdfBuffer, rendererVersion: "chromium-paged-pdf-v2.0" };
  } finally {
    await browser.close().catch(() => {});
  }
};

/**
 * Compiles sandboxed Paged-Media HTML into a real searchable, font-embedded A4 PDF
 * using system headless Chromium when available, or bundled `@sparticuz/chromium` + `puppeteer-core`
 * on Azure App Service / minimal Linux containers.
 * Returns `{ pdfBuffer, rendererVersion }` or `null` if headless Chrome is unavailable.
 */
export const renderHtmlToPdfBuffer = async (html) => {
  const systemBin = await findExecutable(CHROME_CANDIDATES);
  if (systemBin) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ijsds-stage6-pdf-"));
    const htmlPath = path.join(tmpDir, "source.html");
    const pdfPath = path.join(tmpDir, "proof.pdf");
    try {
      await fs.writeFile(htmlPath, html, "utf8");
      await execFileAsync(
        systemBin,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--no-pdf-header-footer",
          `--print-to-pdf=${pdfPath}`,
          `file://${htmlPath}`,
        ],
        { timeout: 60_000 },
      );
      const pdfBuffer = await fs.readFile(pdfPath);
      if (pdfBuffer && pdfBuffer.length >= 200) {
        return { pdfBuffer, rendererVersion: "chromium-paged-pdf-v2.0" };
      }
    } catch (err) {
      console.warn("[stage6] system Chrome compile failed, trying @sparticuz/chromium:", err.message);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  try {
    return await renderWithPuppeteerChromium(html);
  } catch (err) {
    console.error("[stage6] @sparticuz/chromium + puppeteer-core PDF compile failed:", err.message);
    return null;
  }
};

/**
 * Rasterizes every page of a PDF buffer into base64 PNGs using `pdftoppm` for D03 Visual QA.
 * Returns `{ pageCount, pages: [{ page, mimeType, base64 }] }` or `null` if `pdftoppm` is unavailable.
 */
export const rasterizePdfToPngBase64 = async (pdfBuffer, { dpi = 120, maxPages = 12 } = {}) => {
  const pdftoppmBin = await findExecutable([PDFTOPPM_BIN]);
  if (!pdftoppmBin) return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ijsds-stage6-png-"));
  const pdfPath = path.join(tmpDir, "proof.pdf");
  const outPrefix = path.join(tmpDir, "page");

  try {
    await fs.writeFile(pdfPath, pdfBuffer);
    await execFileAsync(pdftoppmBin, ["-png", "-r", String(dpi), pdfPath, outPrefix], { timeout: 60_000 });
    const files = (await fs.readdir(tmpDir))
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const pageCount = files.length;
    const pages = [];
    for (let i = 0; i < Math.min(files.length, maxPages); i++) {
      const buf = await fs.readFile(path.join(tmpDir, files[i]));
      pages.push({ page: i + 1, mimeType: "image/png", base64: buf.toString("base64") });
    }
    return { pageCount, pages };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

export const STAGE6E_VISUAL_QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "severity", "category", "description", "locationHint"],
        properties: {
          page: { type: "integer" },
          severity: { type: "string", enum: ["blocker", "warning"] },
          category: {
            type: "string",
            enum: [
              "overflow",
              "collision",
              "blank_page",
              "orphan_heading",
              "broken_table_or_figure",
              "header_footer_mismatch",
              "typography_or_glyph",
            ],
          },
          description: { type: "string" },
          locationHint: { type: "string" },
        },
      },
    },
  },
};

const VISUAL_QA_SYSTEM_PROMPT = `You perform Stage 6E (D03) visual publication QA for the International Journal of Social Work and Development Studies (IJSDS).
Inspect the rasterized A4 proof page images ONLY for visual/layout defects:
- text clipping or margin overflow
- overlapping elements or collisions
- unintended blank pages
- orphan/widow headings stranded at page bottom
- broken tables or cut-off figures
- incorrect or inconsistent running headers, footers, ISSNs, or page folios
- missing glyphs or unreadable typography

Do NOT critique scholarly arguments or propose text rewrites. Return an empty findings array if layout is clean.`;

/**
 * Runs Stage 6E (D03) multimodal Visual QA via `gpt-5` Vision on rasterized proof pages.
 * Degrades cleanly to `{ skipped: true, findings: [] }` when OPENAI_API_KEY is unset or stage disabled.
 */
export const runStage6eVisualQa = async (
  { articleId, manuscriptId, runNo, pages },
  deps = {},
) => {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { skipped: true, findings: [], provider: null, model: null, runId: null, costUsd: 0 };
  }
  try {
    const res = await invokeStructuredTask(
      {
        articleId,
        manuscriptId,
        stage: "stage6",
        task: "stage6e_visual_qa",
        systemPrompt: VISUAL_QA_SYSTEM_PROMPT,
        userPrompt: `Inspect these ${pages.length} rasterized IJSDS proof page(s) in order (page 1 through page ${pages.length}) and report any layout or typography defects.`,
        jsonSchema: STAGE6E_VISUAL_QA_SCHEMA,
        images: pages.map((p) => ({ mimeType: p.mimeType, base64: p.base64 })),
        idempotencyKey: `stage6e:${articleId}:run-${runNo ?? 1}:${Date.now()}`,
      },
      deps,
    );
    if (res.skipped) {
      return { skipped: true, findings: [], provider: null, model: null, runId: null, costUsd: 0 };
    }
    return {
      skipped: false,
      findings: Array.isArray(res.output?.findings) ? res.output.findings : [],
      provider: res.provider,
      model: res.model,
      runId: res.runId,
      costUsd: res.usage?.costUsd ?? 0,
    };
  } catch (err) {
    console.warn("[stage6] D03 visual QA skipped:", err.message);
    return { skipped: true, findings: [], provider: null, model: null, runId: null, costUsd: 0 };
  }
};
