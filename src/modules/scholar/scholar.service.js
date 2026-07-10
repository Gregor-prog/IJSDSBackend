import prisma from "../../config/prisma.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

/**
 * Gets a single published article including its submissions and non-archived file versions.
 * @param {string} id - The article UUID.
 * @returns {Promise<Object>} The article record.
 */
export const getPublishedArticle = async (id) => {
  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      submissions: {
        select: {
          id: true,
          status: true,
          submitted_at: true,
        },
      },
      file_versions: {
        where: { is_archived: false },
        orderBy: { version_number: "desc" },
      },
    },
  });

  if (!article || article.status !== "published") {
    const err = new Error("Article not found or not published");
    err.status = 404;
    throw err;
  }

  return article;
};

/**
 * Gets all published articles ordered by publication date.
 * @returns {Promise<Array>} List of published articles.
 */
export const getAllPublishedArticles = async () => {
  return prisma.article.findMany({
    where: { status: "published" },
    select: {
      id: true,
      title: true,
      abstract: true,
      keywords: true,
      authors: true,
      publication_date: true,
      created_at: true,
      updated_at: true,
      doi: true,
      crossrefDoi: true,
      volume: true,
      issue: true,
    },
    orderBy: { publication_date: "desc" },
  });
};

/**
 * Formats raw JSON authors into a normalized array of { firstName, lastName, affiliation }
 * @param {any} authorsJson - The raw authors field from database.
 * @returns {Array<Object>} List of authors.
 */
export const formatAuthorsForScholar = (authorsJson) => {
  if (!authorsJson) return [];

  // If it's a string, treat it as a single author last name
  if (typeof authorsJson === "string") {
    return [{ firstName: "", lastName: authorsJson, affiliation: "" }];
  }

  if (Array.isArray(authorsJson)) {
    return authorsJson.map((a) => {
      if (typeof a === "string") {
        return { firstName: "", lastName: a, affiliation: "" };
      }
      
      const firstName = a.firstName ?? a.first_name ?? a.given ?? "";
      const lastName = a.lastName ?? a.last_name ?? a.family ?? a.surname ?? a.name ?? "";
      const affiliation = a.affiliation ?? "";

      return { firstName, lastName, affiliation };
    });
  }

  // Fallback for objects
  if (typeof authorsJson === "object") {
    const firstName = authorsJson.firstName ?? authorsJson.first_name ?? authorsJson.given ?? "";
    const lastName = authorsJson.lastName ?? authorsJson.last_name ?? authorsJson.family ?? authorsJson.surname ?? authorsJson.name ?? "";
    const affiliation = authorsJson.affiliation ?? "";
    return [{ firstName, lastName, affiliation }];
  }

  return [];
};

/**
 * Formats a date to Google Scholar required format (YYYY/MM/DD)
 * @param {Date|string} date - Date object or date string.
 * @returns {string} Formatted date.
 */
export const formatDateForScholar = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
};

/**
 * Builds the canonical PDF URL for an article.
 * Prefers manuscript_file_url on the article record; falls back to the latest
 * non-archived FileVersion so that citation_pdf_url is always populated when a
 * PDF exists.
 * @param {Object} article - The article object (must include file_versions).
 * @returns {string|null} Canonical PDF URL or null.
 */
export const buildPdfUrl = (article) => {
  const BASE_URL = process.env.BASE_URL ?? "https://ijsdsbackend-429660256945.europe-southwest1.run.app";

  const resolveUrl = (fileUrl) => {
    if (!fileUrl) return null;
    if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) return fileUrl;
    const cleanPath = fileUrl.startsWith("/") ? fileUrl.substring(1) : fileUrl;
    // PDFs in /uploads/ are served by the backend; use BASE_URL for the file host
    return `${BASE_URL}/${cleanPath}`;
  };

  // Primary: explicit field on the article
  if (article.manuscript_file_url) {
    return resolveUrl(article.manuscript_file_url);
  }

  // Fallback: first non-archived FileVersion (already ordered by version_number desc)
  const latestVersion = article.file_versions?.find((fv) => !fv.is_archived && fv.file_url);
  if (latestVersion) {
    return resolveUrl(latestVersion.file_url);
  }

  return null;
};

/**
 * Builds the canonical article URL (assumes option C reverse proxy path structure)
 * @param {string} id - The article UUID.
 * @returns {string} The canonical URL.
 */
export const buildArticleUrl = (id) => {
  return `${FRONTEND_URL}/papers/${id}`;
};

const slugifyTitle = (t) =>
  String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Builds the human-readable, DOI-embedded canonical URL — the same format the
 * CrossRef deposit registers as the DOI resource URL:
 *   /article/<title-slug>+<doi-with-slashes-as-dashes>
 * Falls back to /article/<id> when the article has no DOI.
 * @param {Object} article
 * @returns {string}
 */
export const buildArticleSlugUrl = (article) => {
  const doi = article.crossrefDoi || article.doi;
  if (doi) {
    return `${FRONTEND_URL}/article/${slugifyTitle(article.title)}+${doi.replace(/\//g, "-")}`;
  }
  return `${FRONTEND_URL}/article/${article.id}`;
};

/**
 * Resolves a published article from a URL slug of the form
 * "<title-slug>+<doi-slug>" (or a raw article id when no DOI was present).
 * The DOI is reconstructed by restoring the "/" that sits right after the
 * "10.xxxx" registrant prefix. Used to server-render /article/:slug so the
 * DOI landing page carries citation metadata (not an empty SPA shell).
 * @param {string} slug
 * @returns {Promise<Object>} The article (with non-archived file_versions).
 */
export const getPublishedArticleBySlug = async (slug) => {
  const decoded = decodeURIComponent(slug);
  const plusIdx = decoded.lastIndexOf("+");

  // No "+" → the slug is the raw article id (buildArticleSlug fallback path)
  if (plusIdx === -1) {
    return getPublishedArticle(decoded);
  }

  const doiSlug = decoded.slice(plusIdx + 1);
  // Restore the slash after the "10.<registrant>" prefix
  const doi = doiSlug.replace(/^(10\.\d+)-/, "$1/");

  const article = await prisma.article.findFirst({
    where: {
      status: "published",
      OR: [{ crossrefDoi: doi }, { doi }],
    },
    include: {
      file_versions: {
        where: { is_archived: false },
        orderBy: { version_number: "desc" },
      },
    },
  });

  if (!article) {
    const err = new Error("Article not found or not published");
    err.status = 404;
    throw err;
  }
  return article;
};
