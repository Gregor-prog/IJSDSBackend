import prisma from "../../config/prisma.js";

const DOAJ_API_URL = "https://doaj.org/api/v3/articles";

const formatArticle = (article) => {
  const authors = Array.isArray(article.authors) ? article.authors : [];
  const pubDate = new Date(article.publication_date ?? article.created_at);

  return {
    bibjson: {
      title: article.title,
      abstract: article.abstract,
      keywords: article.keywords ?? [],
      author: authors.map((a) => ({
        name: typeof a === "string"
          ? a
          : `${a.firstName ?? a.first_name ?? ""} ${a.lastName ?? a.last_name ?? ""}`.trim(),
        affiliation: a.affiliation ?? "",
      })),
      identifier: [{ type: "doi", id: article.doi }],
      link: [{ type: "fulltext", url: article.manuscript_file_url ?? "" }],
      year: pubDate.getFullYear().toString(),
      month: (pubDate.getMonth() + 1).toString(),
      journal: {
        title: "International Journal for Social Work and Development Studies",
        country: "NG",
        language: ["en"],
        license: [{ type: "CC BY", url: "https://creativecommons.org/licenses/by/4.0/" }],
      },
    },
  };
};

const submitOne = async (article) => {
  const res = await fetch(DOAJ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DOAJ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(formatArticle(article)),
  });

  return { ok: res.ok, status: res.status, body: await res.text() };
};

// ── Single article submit ─────────────────────────────────────────────────────

export const submitArticle = async (articleId) => {
  if (!process.env.DOAJ_API_KEY) {
    throw new Error("DOAJ_API_KEY is not configured");
  }

  const article = await prisma.article.findUnique({ where: { id: articleId } });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (!article.doi) {
    const err = new Error("Article must have a DOI before submitting to DOAJ");
    err.status = 422;
    throw err;
  }

  const result = await submitOne(article);

  if (!result.ok) {
    throw new Error(`DOAJ submission failed: ${result.body}`);
  }

  return { articleId: article.id, title: article.title, status: "submitted" };
};

// ── Bulk submit ───────────────────────────────────────────────────────────────

export const bulkSubmit = async (status = "published") => {
  if (!process.env.DOAJ_API_KEY) {
    throw new Error("DOAJ_API_KEY is not configured");
  }

  const articles = await prisma.article.findMany({
    where: { status, doi: { not: null } },
    orderBy: { publication_date: "desc" },
  });

  const succeeded = [];
  const failed = [];

  for (const article of articles) {
    const result = await submitOne(article);
    if (result.ok) {
      succeeded.push(article.id);
    } else {
      failed.push({ id: article.id, error: result.body });
    }
  }

  return {
    total: articles.length,
    succeeded: succeeded.length,
    failed: failed.length,
    errors: failed.length > 0 ? failed : undefined,
  };
};
