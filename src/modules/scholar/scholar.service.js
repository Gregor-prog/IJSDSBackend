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
      status: true,
      volume: true,
      issue: true,
      page_start: true,
      page_end: true,
      subject_area: true,
      funding_info: true,
      manuscript_file_url: true,
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

const cleanDegreeAndTitles = (name) => {
  if (!name) return "";
  return String(name)
    .replace(/\s*\((?:PhD|Ph\.D\.|Ph\.D|Dr\.|MSc|BSc)\)\s*/gi, " ")
    .replace(/\b(?:Dr\.|Dr|Prof\.|Professor|Engr\.|Rev\.|Mr\.|Mrs\.|Ms\.)\s+/gi, "")
    .replace(/,\s*$/g, "")
    .trim();
};

export const cleanTitleForScholar = (title) => {
  if (!title) return "";
  let t = String(title)
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (t === t.toUpperCase() && t.length > 20) {
    t = t.toLowerCase().replace(/(?:^|\s|\b)\w/g, (char) => char.toUpperCase());
  }
  return t;
};

/**
 * Formats raw JSON authors into a normalized array of { firstName, lastName, formattedName, affiliation }
 * @param {any} authorsJson - The raw authors field from database.
 * @returns {Array<Object>} List of authors.
 */
export const formatAuthorsForScholar = (authorsJson) => {
  if (!authorsJson) return [];

  const parseRawAuthor = (raw, affiliation = "") => {
    if (!raw) return null;
    let cleaned = cleanDegreeAndTitles(String(raw));
    cleaned = cleaned.replace(/,\s*$/, "").trim();
    if (!cleaned) return null;

    let firstName = "";
    let lastName = "";
    let formattedName = "";

    if (cleaned.includes(",")) {
      const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
      lastName = parts[0] || "";
      firstName = parts.slice(1).join(" ") || "";
      formattedName = firstName ? `${lastName}, ${firstName}` : lastName;
    } else {
      const parts = cleaned.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        lastName = parts[parts.length - 1];
        firstName = parts.slice(0, -1).join(" ");
        formattedName = `${lastName}, ${firstName}`;
      } else {
        lastName = cleaned;
        firstName = "";
        formattedName = cleaned;
      }
    }

    return {
      firstName,
      lastName,
      formattedName,
      affiliation: affiliation ? String(affiliation).trim() : "",
    };
  };

  if (typeof authorsJson === "string") {
    const author = parseRawAuthor(authorsJson);
    return author ? [author] : [];
  }

  if (Array.isArray(authorsJson)) {
    return authorsJson
      .map((a) => {
        if (typeof a === "string") {
          return parseRawAuthor(a);
        }
        const given = cleanDegreeAndTitles(a.firstName ?? a.first_name ?? a.given ?? "");
        const family = cleanDegreeAndTitles(a.lastName ?? a.last_name ?? a.family ?? a.surname ?? a.name ?? "");
        const affiliation = a.affiliation ?? "";

        if (!given && family) {
          return parseRawAuthor(family, affiliation);
        }

        const formattedName = given && family ? `${family}, ${given}` : (family || given);
        return {
          firstName: given,
          lastName: family,
          formattedName,
          affiliation: affiliation ? String(affiliation).trim() : "",
        };
      })
      .filter(Boolean);
  }

  if (typeof authorsJson === "object") {
    const given = cleanDegreeAndTitles(authorsJson.firstName ?? authorsJson.first_name ?? authorsJson.given ?? "");
    const family = cleanDegreeAndTitles(authorsJson.lastName ?? authorsJson.last_name ?? authorsJson.family ?? authorsJson.surname ?? authorsJson.name ?? "");
    const affiliation = authorsJson.affiliation ?? "";

    if (!given && family) {
      const parsed = parseRawAuthor(family, affiliation);
      return parsed ? [parsed] : [];
    }

    const formattedName = given && family ? `${family}, ${given}` : (family || given);
    return [{
      firstName: given,
      lastName: family,
      formattedName,
      affiliation: affiliation ? String(affiliation).trim() : "",
    }];
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
 * Builds the citation PDF URL for an article.
 * Google Scholar requires the PDF on the same domain as the abstract page, so
 * this always points at the frontend's /api/pdf/<id>.pdf proxy (which resolves
 * the actual file). Returns null when the article has no PDF — manuscript_file_url
 * is often the author's submitted .docx, which must never be advertised.
 * Mirrors hasValidPdf in the frontend's api/article/[slug].ts.
 * @param {Object} article - The article object (must include file_versions).
 * @returns {string|null} Same-domain PDF URL or null.
 */
export const buildPdfUrl = (article) => {
  const isPdf = (fv) =>
    !fv.is_archived &&
    fv.file_url &&
    (fv.file_type === "application/pdf" || String(fv.file_url).toLowerCase().includes(".pdf"));

  const hasPdf =
    article.file_versions?.some(isPdf) ||
    String(article.manuscript_file_url ?? "").toLowerCase().includes(".pdf");

  return hasPdf && article.id ? `${FRONTEND_URL}/api/pdf/${article.id}.pdf` : null;
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
      status: true,
      volume: true,
      issue: true,
      page_start: true,
      page_end: true,
      subject_area: true,
      funding_info: true,
      manuscript_file_url: true,
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
