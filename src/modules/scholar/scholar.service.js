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
 * Builds the canonical PDF URL for an article
 * @param {Object} article - The article object.
 * @returns {string|null} Canonical PDF URL or null.
 */
export const buildPdfUrl = (article) => {
  const fileUrl = article.manuscript_file_url;
  if (!fileUrl) return null;
  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    return fileUrl;
  }
  // Remove leading slash if present
  const cleanPath = fileUrl.startsWith("/") ? fileUrl.substring(1) : fileUrl;
  return `${FRONTEND_URL}/${cleanPath}`;
};

/**
 * Builds the canonical article URL (assumes option C reverse proxy path structure)
 * @param {string} id - The article UUID.
 * @returns {string} The canonical URL.
 */
export const buildArticleUrl = (id) => {
  return `${FRONTEND_URL}/papers/${id}`;
};
