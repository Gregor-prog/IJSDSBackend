import prisma from "../../config/prisma.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const OAI_BASE = `${BASE_URL}/api/oai`;
const REPO_NAME = "International Journal for Social Work and Development Studies";

const esc = (str) =>
  String(str ?? "").replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

const formatAuthors = (authors) => {
  if (!authors) return "";
  if (typeof authors === "string") return esc(authors);
  if (Array.isArray(authors))
    return authors
      .map((a) =>
        typeof a === "string"
          ? esc(a)
          : esc(`${a.firstName ?? a.first_name ?? ""} ${a.lastName ?? a.last_name ?? ""}`.trim())
      )
      .join("; ");
  return "";
};

const oaiHeader = (verb, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/ http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd">
  <responseDate>${new Date().toISOString()}</responseDate>
  <request verb="${verb}"${extra}>${OAI_BASE}</request>`;

const oaiFooter = `\n</OAI-PMH>`;

const recordXml = (article) => `
  <record>
    <header>
      <identifier>oai:ijsds:${esc(article.doi)}</identifier>
      <datestamp>${new Date(article.publication_date ?? article.created_at).toISOString()}</datestamp>
    </header>
    <metadata>
      <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/"
                 xsi:schemaLocation="http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd">
        <dc:title>${esc(article.title)}</dc:title>
        <dc:creator>${formatAuthors(article.authors)}</dc:creator>
        <dc:subject>${esc((article.keywords ?? []).join(", "))}</dc:subject>
        <dc:description>${esc(article.abstract)}</dc:description>
        <dc:publisher>${REPO_NAME}</dc:publisher>
        <dc:date>${article.publication_date ?? article.created_at}</dc:date>
        <dc:type>Text</dc:type>
        <dc:format>application/pdf</dc:format>
        <dc:identifier>doi:${esc(article.doi)}</dc:identifier>
        <dc:language>en</dc:language>
        <dc:rights>Creative Commons Attribution 4.0 International License</dc:rights>
      </oai_dc:dc>
    </metadata>
  </record>`;

const errorXml = (code, message) =>
  `${oaiHeader("error")}\n  <error code="${code}">${esc(message)}</error>${oaiFooter}`;

// ── Verb handlers ─────────────────────────────────────────────────────────────

export const identify = () =>
  `${oaiHeader("Identify")}
  <Identify>
    <repositoryName>${REPO_NAME}</repositoryName>
    <baseURL>${OAI_BASE}</baseURL>
    <protocolVersion>2.0</protocolVersion>
    <adminEmail>editor@ijsds.org</adminEmail>
    <earliestDatestamp>2024-01-01T00:00:00Z</earliestDatestamp>
    <deletedRecord>no</deletedRecord>
    <granularity>YYYY-MM-DDThh:mm:ssZ</granularity>
  </Identify>${oaiFooter}`;

export const listMetadataFormats = () =>
  `${oaiHeader("ListMetadataFormats")}
  <ListMetadataFormats>
    <metadataFormat>
      <metadataPrefix>oai_dc</metadataPrefix>
      <schema>http://www.openarchives.org/OAI/2.0/oai_dc.xsd</schema>
      <metadataNamespace>http://www.openarchives.org/OAI/2.0/oai_dc/</metadataNamespace>
    </metadataFormat>
  </ListMetadataFormats>${oaiFooter}`;

export const listRecords = async (metadataPrefix) => {
  if (metadataPrefix !== "oai_dc") {
    return errorXml("cannotDisseminateFormat", "Unsupported metadata format");
  }

  const articles = await prisma.article.findMany({
    where: { status: "published", doi: { not: null } },
    orderBy: { publication_date: "desc" },
  });

  const records = articles.map(recordXml).join("\n");

  return `${oaiHeader("ListRecords", ' metadataPrefix="oai_dc"')}
  <ListRecords>${records}
  </ListRecords>${oaiFooter}`;
};

export const getRecord = async (identifier, metadataPrefix) => {
  if (metadataPrefix !== "oai_dc") {
    return errorXml("cannotDisseminateFormat", "Unsupported metadata format");
  }

  const doi = identifier?.replace("oai:ijsds:", "") ?? "";

  const article = await prisma.article.findFirst({
    where: { doi, status: "published" },
  });

  if (!article) return errorXml("idDoesNotExist", "Record not found");

  return `${oaiHeader("GetRecord", ` identifier="${esc(identifier)}" metadataPrefix="oai_dc"`)}
  <GetRecord>${recordXml(article)}
  </GetRecord>${oaiFooter}`;
};

export const handleVerb = async ({ verb, metadataPrefix, identifier }) => {
  switch (verb) {
    case "Identify":
      return identify();
    case "ListMetadataFormats":
      return listMetadataFormats();
    case "ListRecords":
      return listRecords(metadataPrefix);
    case "GetRecord":
      return getRecord(identifier, metadataPrefix);
    default:
      return errorXml("badVerb", "Unrecognised or missing verb");
  }
};
