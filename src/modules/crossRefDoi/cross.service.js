import prisma from "../../config/prisma.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CROSSREF_DEPOSIT_URL =
  process.env.CROSSREF_SANDBOX === "true"
    ? "https://test.crossref.org/servlet/deposit"
    : "https://doi.crossref.org/servlet/deposit";

const JOURNAL = {
  fullTitle: "International Journal of Social Work and Development Studies",
  abbrevTitle: "IJSDS",
  // Registered ISSNs; env vars may override but a missing var must never drop them from deposits.
  get issn() { return process.env.CROSSREF_JOURNAL_ISSN || "3115-6932"; },
  get issnPrint() { return process.env.CROSSREF_JOURNAL_ISSN_PRINT || "3115-6940"; },
  get prefix() { return process.env.CROSSREF_DOI_PREFIX ?? "10.67007"; },
};

// ── DOI suffix generator ──────────────────────────────────────────────────────
// Pattern: ijsds-<year>-v<vol>_i<issue>_<NNN>  e.g. ijsds-2026-v1_i2_003
// Article number is sequential within the same volume+issue.
// Fallback (no vol/issue): ijsds-<year>-<first8charsOfId>

const buildSuffix = async (article, db = prisma) => {
  const year = new Date(article.publication_date ?? article.created_at ?? Date.now()).getFullYear();

  if (article.volume && article.issue) {
    // Next number = highest suffix already used + 1 (a count would re-issue numbers and
    // overwrite a live DOI at Crossref).
    // Look at every DOI ever issued with this volume/issue pattern, wherever that article sits
    // now (an article moved to another issue keeps its DOI, so its number stays taken).
    const stem = `ijsds-${year}-v${article.volume}_i${article.issue}_`;
    const rows = await db.article.findMany({
      where: { crossrefDoi: { startsWith: `${JOURNAL.prefix}/${stem}` } },
      select: { crossrefDoi: true },
    });
    const max = rows.reduce((m, r) => {
      const n = Number(r.crossrefDoi.match(/_(\d+)$/)?.[1]);
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    return `${stem}${String(max + 1).padStart(3, "0")}`;
  }

  // Fallback: first 8 chars of the article UUID (still unique, still opaque)
  return `ijsds-${year}-${article.id.slice(0, 8)}`;
};

/**
 * Picks the next DOI for an article and RESERVES it on the article in one transaction, serialised
 * per volume+issue with an advisory lock, so two concurrent registrations can never pick the same
 * number. The reservation happens before anything is sent to Crossref.
 */
const reserveDoi = (article) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`crossref:${article.volume}:${article.issue}`}))`;
    const fresh = await tx.article.findUnique({ where: { id: article.id }, select: { crossrefDoi: true } });
    if (fresh?.crossrefDoi) return { doi: fresh.crossrefDoi, alreadyReserved: true };
    const doi = `${JOURNAL.prefix}/${await buildSuffix(article, tx)}`;
    await tx.article.update({ where: { id: article.id }, data: { crossrefDoi: doi } });
    return { doi, alreadyReserved: false };
  });

export const buildDoi = async (article) =>
  `${JOURNAL.prefix}/${await buildSuffix(article)}`;

// ── XML helpers ───────────────────────────────────────────────────────────────

const esc = (str) =>
  xmlSafe(str).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

// Strips characters that are illegal in XML 1.0 (common in text pasted from Word).
const xmlSafe = (str) => String(str ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

// Stored authors are usually { name, email, affiliation, orcid }. Split "name" into given/family
// the same way the Scholar meta tags do ("Last, First" or "First ... Last").
const splitName = (a) => {
  const first = a.first_name ?? a.firstName ?? a.given;
  const last = a.last_name ?? a.lastName ?? a.family ?? a.surname;
  if (first || last) return { given: first ?? "", family: last ?? first ?? "" };
  const raw = String(a.name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (raw.includes(",")) {
    const [fam, ...rest] = raw.split(",").map((x) => x.trim()).filter(Boolean);
    return { given: rest.join(" "), family: fam };
  }
  const parts = raw.split(" ");
  return parts.length > 1 ? { given: parts.slice(0, -1).join(" "), family: parts.at(-1) } : { given: "", family: raw };
};

const ORCID_RE = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

const formatContributors = (authors) => {
  if (!authors || !Array.isArray(authors) || authors.length === 0) return "";
  const people = authors.map((a) => ({ a, n: splitName(a) })).filter((x) => x.n && x.n.family);
  if (!people.length) return "";

  return `<contributors>${people
    .map(({ a, n }, i) => {
      const affiliation = a.affiliation ?? "";
      const orcid = String(a.orcid ?? a.orcid_id ?? "").match(ORCID_RE)?.[1];
      return `
      <person_name sequence="${i === 0 ? "first" : "additional"}" contributor_role="author">
        ${n.given ? `<given_name>${esc(n.given)}</given_name>` : ""}
        <surname>${esc(n.family)}</surname>
        ${affiliation ? `<affiliations><institution><institution_name>${esc(affiliation)}</institution_name></institution></affiliations>` : ""}
        ${orcid ? `<ORCID>https://orcid.org/${orcid.toUpperCase()}</ORCID>` : ""}
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
  const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const titleSlug = slugify(article.title);
  const doiSlug = doi.replace(/\//g, "-");
  const resourceUrl = `${process.env.FRONTEND_URL ?? "https://www.ijsds.org"}/article/${titleSlug}+${doiSlug}`;

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

        ${article.abstract ? `
        <abstract xmlns="http://www.ncbi.nlm.nih.gov/JATS1">
          <p>${esc(article.abstract)}</p>
        </abstract>` : ""}

        ${formatDate(pubDate)}

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

  const body = await res.text();

  console.log(`[crossref] Deposit response (${res.status}):\n${body.slice(0, 500)}`);

  if (!res.ok) {
    throw new Error(`CrossRef deposit HTTP error ${res.status}: ${body}`);
  }

  if (body.includes("login-screen") || body.includes("login_passwd") || body.toLowerCase().includes("please login")) {
    throw new Error("CrossRef authentication failed — check CROSSREF_LOGIN_ID and CROSSREF_LOGIN_PASSWD");
  }

  const queued = body.toLowerCase().includes("success") ||
    body.includes("doi_batch_id") ||
    body.includes("submission_id");

  if (!queued) {
    throw new Error(`CrossRef deposit not queued. Response: ${body.slice(0, 300)}`);
  }

  return { queued, batchId, response: body };
};

// ── Main service function ─────────────────────────────────────────────────────

const CROSSREF_ARTICLE_SELECT = {
  id: true, title: true, abstract: true, authors: true, keywords: true,
  doi: true, crossrefDoi: true, volume: true, issue: true,
  page_start: true, page_end: true, subject_area: true,
  publication_date: true, created_at: true,
};

export const registerDoi = async ({ articleId }) => {
  const article = await prisma.article.findUnique({ where: { id: articleId }, select: CROSSREF_ARTICLE_SELECT });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (article.crossrefDoi) {
    const err = new Error(
      `Article already has CrossRef DOI: ${article.crossrefDoi}. Use reDepositDoi to update metadata.`
    );
    err.status = 409;
    throw err;
  }

  // A DOI must never be minted before Volume/Issue exist: the suffix format
  // (ijsds-<year>-v<vol>_i<issue>_<NNN>) is derived from them, and once a
  // DOI is deposited with CrossRef it is permanent — reDepositDoi can only
  // update metadata for the existing DOI string, it cannot change the DOI
  // itself. Registering early would permanently strand the article on the
  // opaque UUID-fallback suffix even after Volume/Issue are later assigned.
  if (!article.volume || !article.issue) {
    const err = new Error(
      "Cannot register a CrossRef DOI until the article has a Volume and Issue assigned. Assign them (Production → Issues → Approve for Processing) first."
    );
    err.status = 422;
    throw err;
  }

  const { doi, alreadyReserved } = await reserveDoi(article);
  const batchId = `ijsds-batch-${article.id.slice(0, 8)}-${Date.now()}`;
  const xml = buildDepositXml(article, doi, batchId);

  let result;
  try {
    result = await depositXml(xml, batchId);
  } catch (e) {
    // Deposit never reached Crossref: release a reservation made by THIS call so a retry
    // re-reserves cleanly. (An older reservation is kept: that DOI may already be live.)
    if (!alreadyReserved) {
      await prisma.article.updateMany({ where: { id: articleId, crossrefDoi: doi }, data: { crossrefDoi: null } }).catch(() => {});
    }
    throw e;
  }

  console.log(`[crossref] DOI ${doi} deposited for article ${articleId} (batch: ${batchId})`);

  // IJSDS 2.0: a registered DOI completes Stage 6 — queue the paper for the 28th batch.
  const { promoteReadyForRelease } = await import("../ijsds2/manuscripts.service.js");
  promoteReadyForRelease({ articleId }).catch((e) => console.error("[ijsds2] promote after DOI failed:", e.message));

  return {
    doi,
    batch_id: batchId,
    queued: result.queued,
    crossref_response: result.response,
  };
};

// ── Re-deposit for corrections/updates ───────────────────────────────────────

export const reDepositDoi = async ({ articleId }) => {
  const article = await prisma.article.findUnique({ where: { id: articleId }, select: CROSSREF_ARTICLE_SELECT });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (!article.crossrefDoi) {
    const err = new Error("Article has no CrossRef DOI. Use registerDoi first.");
    err.status = 400;
    throw err;
  }

  const batchId = `ijsds-update-${article.id.slice(0, 8)}-${Date.now()}`;
  const xml = buildDepositXml(article, article.crossrefDoi, batchId);

  const result = await depositXml(xml, batchId);

  console.log(`[crossref] Re-deposited DOI ${article.crossrefDoi} for article ${articleId} (batch: ${batchId})`);

  return {
    doi: article.crossrefDoi,
    batch_id: batchId,
    queued: result.queued,
    crossref_response: result.response,
  };
};
