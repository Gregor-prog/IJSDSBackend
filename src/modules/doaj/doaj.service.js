import prisma from "../../config/prisma.js";
import { formatAuthorsForScholar, buildArticleSlugUrl } from "../scholar/scholar.service.js";

// DOAJ API v4 (https://doaj.org/api/v4/docs). Article model:
// https://doaj.github.io/doaj-docs/master/data_models/IncomingAPIArticle
// - Authentication is the api_key query parameter.
// - An eissn or pissn identifier is REQUIRED; DOAJ matches the article to the journal by ISSN,
//   so the journal itself must already be in DOAJ or the upload is rejected.
// - Journal title/publisher/country/language are filled in by DOAJ from the journal record.
// - Re-submitting must PUT to the existing DOAJ id, otherwise DOAJ creates a duplicate.

const DOAJ_API = "https://doaj.org/api/articles";
const ISSN_E = "3115-6932";
const ISSN_P = "3115-6940";
const ORCID_RE = /(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const formatArticle = (article) => {
  const doi = article.crossrefDoi || article.doi;
  const pubDate = new Date(article.publication_date ?? article.created_at);
  const raw = Array.isArray(article.authors) ? article.authors : [];
  const parsed = formatAuthorsForScholar(article.authors);

  const author = parsed
    .map((p, i) => {
      const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
      if (!name) return null;
      const orcid = String(raw[i]?.orcid ?? raw[i]?.orcid_id ?? "").match(ORCID_RE)?.[1];
      return {
        name,
        ...(p.affiliation ? { affiliation: p.affiliation } : {}),
        ...(orcid ? { orcid_id: `https://orcid.org/${orcid.toUpperCase()}` } : {}),
      };
    })
    .filter(Boolean);

  return {
    bibjson: {
      title: article.title,
      ...(article.abstract ? { abstract: article.abstract } : {}),
      ...(author.length ? { author } : {}),
      keywords: (article.keywords ?? []).filter(Boolean).slice(0, 6), // DOAJ allows up to 6
      identifier: [
        ...(doi ? [{ type: "doi", id: doi }] : []),
        { type: "eissn", id: ISSN_E },
        { type: "pissn", id: ISSN_P },
      ],
      link: [{ type: "fulltext", url: buildArticleSlugUrl(article), content_type: "HTML" }],
      year: String(pubDate.getFullYear()),
      month: String(pubDate.getMonth() + 1),
      journal: {
        ...(article.volume ? { volume: String(article.volume) } : {}),
        ...(article.issue ? { number: String(article.issue) } : {}),
        ...(article.page_start ? { start_page: String(article.page_start) } : {}),
        ...(article.page_end ? { end_page: String(article.page_end) } : {}),
      },
    },
  };
};

const sendOne = async (article) => {
  const key = encodeURIComponent(process.env.DOAJ_API_KEY);
  const update = Boolean(article.doaj_article_id);
  const url = update ? `${DOAJ_API}/${encodeURIComponent(article.doaj_article_id)}?api_key=${key}` : `${DOAJ_API}?api_key=${key}`;
  const res = await fetch(url, {
    method: update ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(formatArticle(article)),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
  if (!res.ok) return { ok: false, status: res.status, error: body?.error ?? text.slice(0, 500) };

  const doajId = update ? article.doaj_article_id : body?.id;
  if (doajId && !update) await prisma.article.update({ where: { id: article.id }, data: { doaj_article_id: doajId } });
  return { ok: true, status: res.status, doajId, updated: update };
};

const SELECT = {
  id: true, title: true, abstract: true, authors: true, keywords: true, status: true,
  doi: true, crossrefDoi: true, volume: true, issue: true, page_start: true, page_end: true,
  publication_date: true, created_at: true, doaj_article_id: true,
};

const requireKey = () => {
  if (!process.env.DOAJ_API_KEY) throw httpError(500, "DOAJ_API_KEY is not configured");
};

export const submitArticle = async (articleId) => {
  requireKey();
  const article = await prisma.article.findUnique({ where: { id: articleId }, select: SELECT });
  if (!article) throw httpError(404, "Article not found");
  if (article.status !== "published") throw httpError(422, "Only published articles can be sent to DOAJ");
  if (!(article.crossrefDoi || article.doi)) throw httpError(422, "Article must have a DOI before submitting to DOAJ");

  const r = await sendOne(article);
  if (!r.ok) throw httpError(502, `DOAJ rejected the article (HTTP ${r.status}): ${r.error}`);
  return { articleId: article.id, title: article.title, doajId: r.doajId, status: r.updated ? "updated" : "submitted" };
};

export const bulkSubmit = async () => {
  requireKey();
  const articles = await prisma.article.findMany({
    where: { status: "published", OR: [{ crossrefDoi: { not: null } }, { doi: { not: null } }] },
    orderBy: { publication_date: "desc" },
    select: SELECT,
  });
  const failed = [];
  let submitted = 0, updated = 0;
  for (const article of articles) {
    const r = await sendOne(article).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) failed.push({ id: article.id, title: article.title, error: r.error });
    else if (r.updated) updated++;
    else submitted++;
  }
  return { total: articles.length, submitted, updated, failed: failed.length, errors: failed.length ? failed : undefined };
};
