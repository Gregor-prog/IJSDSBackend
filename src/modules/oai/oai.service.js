import prisma from "../../config/prisma.js";
import { formatAuthorsForScholar, buildArticleSlugUrl, buildPdfUrl } from "../scholar/scholar.service.js";

// OAI-PMH 2.0 data provider (https://www.openarchives.org/OAI/openarchivesprotocol.html).
// Records are published articles, identified by their article id (stable even before a DOI).

const BASE_URL = (process.env.BASE_URL || "https://ijsds-database-ftb5hpfrfecegtbz.switzerlandnorth-01.azurewebsites.net").replace(/\/$/, "");
const OAI_BASE = `${BASE_URL}/api/oai`;
const REPO_NAME = "International Journal of Social Work and Development Studies";
const ID_PREFIX = "oai:ijsds.org:";
const PAGE_SIZE = 100;
const ISSN_E = "3115-6932";
const ISSN_P = "3115-6940";

const esc = (str) =>
  String(str ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

const isoSeconds = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

const VERBS = {
  Identify: { required: [], optional: [] },
  ListMetadataFormats: { required: [], optional: ["identifier"] },
  ListSets: { required: [], optional: [], exclusive: "resumptionToken" },
  GetRecord: { required: ["identifier", "metadataPrefix"], optional: [] },
  ListIdentifiers: { required: ["metadataPrefix"], optional: ["from", "until", "set"], exclusive: "resumptionToken" },
  ListRecords: { required: ["metadataPrefix"], optional: ["from", "until", "set"], exclusive: "resumptionToken" },
};

// ── Envelope ──────────────────────────────────────────────────────────────────────

const envelope = (requestAttrs, body) => `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd">
  <responseDate>${isoSeconds(new Date())}</responseDate>
  <request${Object.entries(requestAttrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("")}>${esc(OAI_BASE)}</request>
${body}
</OAI-PMH>`;

class OaiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Record serialisation ──────────────────────────────────────────────────────────

const ARTICLE_SELECT = {
  id: true, title: true, abstract: true, authors: true, keywords: true, subject_area: true,
  doi: true, crossrefDoi: true, volume: true, issue: true, page_start: true, page_end: true,
  publication_date: true, created_at: true, updated_at: true, manuscript_file_url: true,
  file_versions: { where: { is_archived: false }, select: { file_url: true, file_type: true, is_archived: true } },
};

const headerXml = (a) => `    <header>
      <identifier>${ID_PREFIX}${a.id}</identifier>
      <datestamp>${isoSeconds(a.updated_at ?? a.created_at)}</datestamp>
    </header>`;

const dcXml = (a) => {
  const doi = a.crossrefDoi || a.doi;
  const creators = formatAuthorsForScholar(a.authors).map((x) => `        <dc:creator>${esc(x.formattedName)}</dc:creator>`);
  const subjects = [...(a.keywords ?? []), ...(a.subject_area ? [a.subject_area] : [])].filter(Boolean).map((k) => `        <dc:subject>${esc(k)}</dc:subject>`);
  const pdf = buildPdfUrl(a);
  const pages = a.page_start ? `, pp. ${a.page_start}${a.page_end ? `-${a.page_end}` : ""}` : "";
  const source = `${REPO_NAME}${a.volume ? `, Vol. ${a.volume}` : ""}${a.issue ? `, No. ${a.issue}` : ""}${pages}`;
  return `    <metadata>
      <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/"
                 xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">
        <dc:title>${esc(a.title)}</dc:title>
${creators.join("\n")}
${subjects.join("\n")}
        <dc:description>${esc(a.abstract)}</dc:description>
        <dc:publisher>${esc(REPO_NAME)}</dc:publisher>
        <dc:date>${isoDay(a.publication_date ?? a.created_at)}</dc:date>
        <dc:type>Text</dc:type>
        <dc:type>info:eu-repo/semantics/article</dc:type>
        <dc:format>${pdf ? "application/pdf" : "text/html"}</dc:format>
        <dc:identifier>${esc(buildArticleSlugUrl(a))}</dc:identifier>
${doi ? `        <dc:identifier>https://doi.org/${esc(doi)}</dc:identifier>\n` : ""}${pdf ? `        <dc:relation>${esc(pdf)}</dc:relation>\n` : ""}        <dc:source>${esc(source)}</dc:source>
        <dc:source>ISSN ${ISSN_E}</dc:source>
        <dc:source>ISSN ${ISSN_P}</dc:source>
        <dc:language>en</dc:language>
        <dc:rights>https://creativecommons.org/licenses/by/4.0/</dc:rights>
        <dc:rights>info:eu-repo/semantics/openAccess</dc:rights>
      </oai_dc:dc>
    </metadata>`;
};

// ── Argument handling ─────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const parseDate = (v, name, endOfDay) => {
  if (v === undefined) return { date: undefined, gran: null };
  if (DAY.test(v)) {
    const d = new Date(`${v}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
    if (!isNaN(d)) return { date: d, gran: "day" };
  }
  if (SECOND.test(v)) {
    const d = new Date(v);
    if (!isNaN(d)) return { date: d, gran: "second" };
  }
  throw new OaiError("badArgument", `Illegal ${name} date: ${v}`);
};

const encodeToken = (state) => Buffer.from(JSON.stringify(state)).toString("base64url");
const decodeToken = (token) => {
  try {
    const s = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    if (typeof s.offset !== "number" || !["oai_dc"].includes(s.prefix)) throw new Error();
    return s;
  } catch {
    throw new OaiError("badResumptionToken", "The resumption token is invalid or has expired");
  }
};

const checkArgs = (args) => {
  const { verb, ...rest } = args;
  const spec = VERBS[verb];
  if (!spec) throw new OaiError("badVerb", verb ? `Illegal verb: ${verb}` : "Missing verb argument");
  for (const [k, v] of Object.entries(rest)) {
    if (Array.isArray(v)) throw new OaiError("badArgument", `Repeated argument: ${k}`);
  }
  const keys = Object.keys(rest);
  if (spec.exclusive && keys.includes(spec.exclusive)) {
    if (keys.length > 1) throw new OaiError("badArgument", `${spec.exclusive} is an exclusive argument`);
    return;
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const illegal = keys.filter((k) => !allowed.has(k));
  if (illegal.length) throw new OaiError("badArgument", `Illegal argument(s): ${illegal.join(", ")}`);
  const missing = spec.required.filter((k) => !rest[k]);
  if (missing.length) throw new OaiError("badArgument", `Missing required argument(s): ${missing.join(", ")}`);
};

const idFromIdentifier = async (identifier) => {
  if (identifier?.startsWith(ID_PREFIX)) {
    const id = identifier.slice(ID_PREFIX.length);
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  }
  // Older identifiers were oai:ijsds:<doi>; keep resolving them.
  if (identifier?.startsWith("oai:ijsds:")) {
    const doi = identifier.slice("oai:ijsds:".length);
    const a = await prisma.article.findFirst({ where: { status: "published", OR: [{ crossrefDoi: doi }, { doi }] }, select: { id: true } });
    return a?.id ?? null;
  }
  return null;
};

// ── Verbs ─────────────────────────────────────────────────────────────────────────

const identify = async () => {
  const earliest = await prisma.article.findFirst({ where: { status: "published" }, orderBy: { updated_at: "asc" }, select: { updated_at: true } });
  return `  <Identify>
    <repositoryName>${esc(REPO_NAME)}</repositoryName>
    <baseURL>${esc(OAI_BASE)}</baseURL>
    <protocolVersion>2.0</protocolVersion>
    <adminEmail>editor@ijsds.org</adminEmail>
    <earliestDatestamp>${isoSeconds(earliest?.updated_at ?? "2025-01-01T00:00:00Z")}</earliestDatestamp>
    <deletedRecord>no</deletedRecord>
    <granularity>YYYY-MM-DDThh:mm:ssZ</granularity>
  </Identify>`;
};

const listMetadataFormats = async ({ identifier }) => {
  if (identifier) {
    const id = await idFromIdentifier(identifier);
    const exists = id && (await prisma.article.findFirst({ where: { id, status: "published" }, select: { id: true } }));
    if (!exists) throw new OaiError("idDoesNotExist", `No record with identifier ${identifier}`);
  }
  return `  <ListMetadataFormats>
    <metadataFormat>
      <metadataPrefix>oai_dc</metadataPrefix>
      <schema>http://www.openarchives.org/OAI/2.0/oai_dc.xsd</schema>
      <metadataNamespace>http://www.openarchives.org/OAI/2.0/oai_dc/</metadataNamespace>
    </metadataFormat>
  </ListMetadataFormats>`;
};

const getRecord = async ({ identifier, metadataPrefix }) => {
  if (metadataPrefix !== "oai_dc") throw new OaiError("cannotDisseminateFormat", `Unsupported metadataPrefix: ${metadataPrefix}`);
  const id = await idFromIdentifier(identifier);
  const a = id && (await prisma.article.findFirst({ where: { id, status: "published" }, select: ARTICLE_SELECT }));
  if (!a) throw new OaiError("idDoesNotExist", `No record with identifier ${identifier}`);
  return `  <GetRecord>
  <record>
${headerXml(a)}
${dcXml(a)}
  </record>
  </GetRecord>`;
};

const listItems = async (args, withMetadata) => {
  let state;
  if (args.resumptionToken) {
    state = decodeToken(args.resumptionToken);
  } else {
    if (args.metadataPrefix !== "oai_dc") throw new OaiError("cannotDisseminateFormat", `Unsupported metadataPrefix: ${args.metadataPrefix}`);
    if (args.set) throw new OaiError("noSetHierarchy", "This repository does not support sets");
    const from = parseDate(args.from, "from", false);
    const until = parseDate(args.until, "until", true);
    if (from.gran && until.gran && from.gran !== until.gran) throw new OaiError("badArgument", "from and until must have the same granularity");
    if (from.date && until.date && from.date > until.date) throw new OaiError("badArgument", "from is later than until");
    state = { offset: 0, prefix: "oai_dc", from: from.date?.toISOString(), until: until.date?.toISOString() };
  }

  const where = {
    status: "published",
    ...(state.from || state.until
      ? { updated_at: { ...(state.from ? { gte: new Date(state.from) } : {}), ...(state.until ? { lte: new Date(state.until) } : {}) } }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.article.count({ where }),
    prisma.article.findMany({ where, orderBy: [{ updated_at: "asc" }, { id: "asc" }], skip: state.offset, take: PAGE_SIZE, select: ARTICLE_SELECT }),
  ]);
  if (rows.length === 0) {
    if (args.resumptionToken) throw new OaiError("badResumptionToken", "The resumption token is invalid or has expired");
    throw new OaiError("noRecordsMatch", "No records match the request");
  }

  const nextOffset = state.offset + rows.length;
  const more = nextOffset < total;
  const token = more
    ? `<resumptionToken completeListSize="${total}" cursor="${state.offset}">${encodeToken({ ...state, offset: nextOffset })}</resumptionToken>`
    : state.offset > 0
      ? `<resumptionToken completeListSize="${total}" cursor="${state.offset}"/>`
      : "";

  const tag = withMetadata ? "ListRecords" : "ListIdentifiers";
  const items = rows
    .map((a) => (withMetadata ? `  <record>\n${headerXml(a)}\n${dcXml(a)}\n  </record>` : headerXml(a).replace(/^ {4}/gm, "  ")))
    .join("\n");
  return `  <${tag}>
${items}
    ${token}
  </${tag}>`;
};

// ── Entry point ───────────────────────────────────────────────────────────────────

export const handleVerb = async (rawArgs) => {
  const args = Object.fromEntries(Object.entries(rawArgs ?? {}).filter(([, v]) => v !== undefined && v !== ""));
  try {
    checkArgs(args);
    const body = await {
      Identify: () => identify(),
      ListMetadataFormats: () => listMetadataFormats(args),
      ListSets: () => {
        throw new OaiError("noSetHierarchy", "This repository does not support sets");
      },
      GetRecord: () => getRecord(args),
      ListIdentifiers: () => listItems(args, false),
      ListRecords: () => listItems(args, true),
    }[args.verb]();
    return envelope(args, body);
  } catch (e) {
    if (!(e instanceof OaiError)) throw e;
    // For badVerb / badArgument the <request> element must not echo the arguments.
    const attrs = e.code === "badVerb" || e.code === "badArgument" ? {} : args;
    return envelope(attrs, `  <error code="${e.code}">${esc(e.message)}</error>`);
  }
};
