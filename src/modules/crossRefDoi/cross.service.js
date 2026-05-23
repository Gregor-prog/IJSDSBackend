import prisma from "../../config/prisma.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CROSSREF_DEPOSIT_URL =
  process.env.CROSSREF_SANDBOX === "true"
    ? "https://test.crossref.org/servlet/deposit"
    : "https://doi.crossref.org/servlet/deposit";

const JOURNAL = {
  fullTitle: "International Journal for Social Work and Development Studies",
  abbrevTitle: "IJSDS",
  issn: process.env.CROSSREF_JOURNAL_ISSN ?? "",           // e-ISSN
  issnPrint: process.env.CROSSREF_JOURNAL_ISSN_PRINT ?? "",
  prefix: process.env.CROSSREF_DOI_PREFIX ?? "10.70407",   // your CrossRef member prefix
};

// ── DOI suffix generator ──────────────────────────────────────────────────────
// Pattern: ijsds-<year>-<seq>  e.g. ijsds-2026-00142
// "seq" is the last 5 digits of the article's creation timestamp + a random 2-digit salt
// → opaque, journal-scoped, unique, short enough for CrossRef

const buildSuffix = (article) => {
  const year = new Date(article.created_at ?? Date.now()).getFullYear();
  const ts = String(Date.parse(article.created_at ?? new Date())).slice(-5);
  const salt = String(Math.floor(Math.random() * 90) + 10); // 10-99
  return `ijsds-${year}-${ts}${salt}`;
};

export const buildDoi = (article) =>
  `${JOURNAL.prefix}/${buildSuffix(article)}`;

// ── XML helpers ───────────────────────────────────────────────────────────────

const esc = (str) =>
  String(str ?? "").replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

const formatContributors = (authors) => {
  if (!authors || !Array.isArray(authors) || authors.length === 0) return "";

  return `<contributors>${authors
    .map((a, i) => {
      const first =
        a.first_name ?? a.firstName ?? a.given ?? "";
      const last =
        a.last_name ?? a.lastName ?? a.family ?? a.surname ?? a.name ?? "";
      const affiliation = a.affiliation ?? "";
      const sequence = i === 0 ? "first" : "additional";

      return `
      <person_name sequence="${sequence}" contributor_role="author">
        ${first ? `<given_name>${esc(first)}</given_name>` : ""}
        <surname>${esc(last || first)}</surname>
        ${affiliation ? `<affiliation>${esc(affiliation)}</affiliation>` : ""}
      </person_name>`;
    })
    .join("")}
  </contributors>`;
};

const formatDate = (dateVal) => {
  const d = dateVal ? new Date(dateVal) : new Date();
  return `
    <publication_date media_type="online">
      <month>${String(d.getMonth() + 1).padStart(2, "0")}</month>
      <day>${String(d.getDate()).padStart(2, "0")}</day>
      <year>${d.getFullYear()}</year>
    </publication_date>`;
};

// ── XML compiler (CrossRef schema 5.4.0) ─────────────────────────────────────

export const buildDepositXml = (article, doi, batchId) => {
  const timestamp = Date.now();
  const pubDate = article.publication_date ?? article.created_at ?? new Date();
  const resourceUrl = `${process.env.FRONTEND_URL ?? "https://www.ijsds.org"}/articles/${article.id}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<doi_batch version="5.4.0"
  xmlns="http://www.crossref.org/schema/5.4.0"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.crossref.org/schema/5.4.0
    https://www.crossref.org/schemas/crossref5.4.0.xsd">

  <head>
    <doi_batch_id>${esc(batchId)}</doi_batch_id>
    <timestamp>${timestamp}</timestamp>
    <depositor>
      <depositor_name>${esc(process.env.CROSSREF_DEPOSITOR_NAME ?? "IJSDS Editorial Office")}</depositor_name>
      <email_address>${esc(process.env.CROSSREF_DEPOSITOR_EMAIL ?? "editor@ijsds.org")}</email_address>
    </depositor>
    <registrant>${esc(process.env.CROSSREF_REGISTRANT ?? "IJSDS")}</registrant>
  </head>

  <body>
    <journal>

      <journal_metadata language="en">
        <full_title>${esc(JOURNAL.fullTitle)}</full_title>
        <abbrev_title>${esc(JOURNAL.abbrevTitle)}</abbrev_title>
        ${JOURNAL.issn ? `<issn media_type="electronic">${esc(JOURNAL.issn)}</issn>` : ""}
        ${JOURNAL.issnPrint ? `<issn media_type="print">${esc(JOURNAL.issnPrint)}</issn>` : ""}
      </journal_metadata>

      ${article.volume || article.issue ? `
      <journal_issue>
        ${formatDate(pubDate)}
        ${article.volume ? `<journal_volume><volume>${esc(String(article.volume))}</volume></journal_volume>` : ""}
        ${article.issue ? `<issue>${esc(String(article.issue))}</issue>` : ""}
      </journal_issue>` : ""}

      <journal_article publication_type="full_text" language="en">

        <titles>
          <title>${esc(article.title)}</title>
        </titles>

        ${formatContributors(article.authors)}

        ${formatDate(pubDate)}

        ${article.abstract ? `
        <abstract xmlns="http://www.ncbi.nlm.nih.gov/JATS1">
          <p>${esc(article.abstract)}</p>
        </abstract>` : ""}

        ${article.page_start ? `
        <pages>
          <first_page>${esc(String(article.page_start))}</first_page>
          ${article.page_end ? `<last_page>${esc(String(article.page_end))}</last_page>` : ""}
        </pages>` : ""}

        <doi_data>
          <doi>${esc(doi)}</doi>
          <resource>${esc(resourceUrl)}</resource>
        </doi_data>

      </journal_article>
    </journal>
  </body>
</doi_batch>`;
};

// ── Deposit to CrossRef ───────────────────────────────────────────────────────

const depositXml = async (xml, batchId) => {
  const loginId = process.env.CROSSREF_LOGIN_ID;
  const loginPasswd = process.env.CROSSREF_LOGIN_PASSWD;

  if (!loginId || !loginPasswd) {
    throw new Error("CROSSREF_LOGIN_ID and CROSSREF_LOGIN_PASSWD must be set");
  }

  const form = new FormData();
  form.append("operation", "doMDUpload");
  form.append("login_id", loginId);
  form.append("login_passwd", loginPasswd);
  form.append(
    "fname",
    new Blob([xml], { type: "application/xml" }),
    `${batchId}.xml`,
  );

  const res = await fetch(CROSSREF_DEPOSIT_URL, { method: "POST", body: form });

  // CrossRef returns 200 even for queued submissions — body contains status
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`CrossRef deposit HTTP error ${res.status}: ${body}`);
  }

  // Successful queue response contains "Your batch submission was successful"
  const queued = body.toLowerCase().includes("success") ||
    body.includes("doi_batch_id");

  return { queued, batchId, response: body };
};

// ── Main service function ─────────────────────────────────────────────────────

export const registerDoi = async ({ articleId }) => {
  const article = await prisma.article.findUnique({ where: { id: articleId } });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (article.doi) {
    const err = new Error(
      `Article already has DOI: ${article.doi}. Use updateDoi to re-deposit.`
    );
    err.status = 409;
    throw err;
  }

  const doi = buildDoi(article);
  const batchId = `ijsds-batch-${article.id.slice(0, 8)}-${Date.now()}`;

  const xml = buildDepositXml(article, doi, batchId);

  const result = await depositXml(xml, batchId);

  // Persist DOI immediately — CrossRef processes asynchronously
  // The DOI is live once CrossRef confirms (usually within minutes)
  await prisma.article.update({
    where: { id: articleId },
    data: { doi },
  });

  console.log(`[crossref] DOI ${doi} deposited for article ${articleId} (batch: ${batchId})`);

  return {
    doi,
    batch_id: batchId,
    queued: result.queued,
    crossref_response: result.response,
  };
};

// ── Re-deposit for corrections/updates ───────────────────────────────────────

export const reDepositDoi = async ({ articleId }) => {
  const article = await prisma.article.findUnique({ where: { id: articleId } });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (!article.doi) {
    const err = new Error("Article has no DOI. Use registerDoi first.");
    err.status = 400;
    throw err;
  }

  const batchId = `ijsds-update-${article.id.slice(0, 8)}-${Date.now()}`;
  const xml = buildDepositXml(article, article.doi, batchId);

  const result = await depositXml(xml, batchId);

  console.log(`[crossref] Re-deposited DOI ${article.doi} for article ${articleId} (batch: ${batchId})`);

  return {
    doi: article.doi,
    batch_id: batchId,
    queued: result.queued,
    crossref_response: result.response,
  };
};
