import {
  getPublishedArticle,
  getPublishedArticleBySlug,
  getAllPublishedArticles,
  formatAuthorsForScholar,
  formatDateForScholar,
  buildPdfUrl,
  buildArticleSlugUrl,
} from "./scholar.service.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

const send404 = (res) =>
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Article Not Found - IJSDS</title>
      <style>
        body { font-family: system-ui, sans-serif; text-align: center; padding: 50px; color: #333; }
        h1 { color: #800000; }
        a { color: #0066cc; text-decoration: none; }
      </style>
    </head>
    <body>
      <h1>404 - Article Not Found</h1>
      <p>The article you are looking for does not exist or has not been published yet.</p>
      <p><a href="${FRONTEND_URL}">Return to Journal Homepage</a></p>
    </body>
    </html>
  `);

/**
 * Renders the shared SSR article page. The canonical/abstract URL is always the
 * DOI-embedded /article/<slug> form so the DOI landing page, the sitemap, and
 * /papers/:id all agree on a single canonical URL (no duplicate content).
 */
const renderArticlePage = (res, article) => {
  const authors = formatAuthorsForScholar(article.authors);
  const publicationDate = formatDateForScholar(article.publication_date ?? article.created_at);
  const isoDate = new Date(article.publication_date ?? article.created_at).toISOString();
  const pdfUrl = buildPdfUrl(article);
  const articleUrl = buildArticleSlugUrl(article);

  return res.render("article", {
    article,
    authors,
    publicationDate,
    isoDate,
    pdfUrl,
    articleUrl,
  });
};

/**
 * SSR a single published article by UUID (/papers/:id — legacy/back-compat).
 */
export const renderArticle = async (req, res, next) => {
  try {
    const article = await getPublishedArticle(req.params.id);
    return renderArticlePage(res, article);
  } catch (err) {
    if (err.status === 404) return send404(res);
    next(err);
  }
};

/**
 * SSR a single published article by DOI slug (/article/:slug and /articles/:slug).
 * This is the URL the CrossRef DOI resolves to, so it must carry citation tags.
 */
export const renderArticleBySlug = async (req, res, next) => {
  try {
    const article = await getPublishedArticleBySlug(req.params.slug);
    return renderArticlePage(res, article);
  } catch (err) {
    if (err.status === 404) return send404(res);
    next(err);
  }
};

/**
 * Render a list of all published articles in HTML
 */
export const renderArticlesList = async (req, res, next) => {
  try {
    const articles = await getAllPublishedArticles();
    return res.render("articles-list", {
      articles,
      baseUrl: FRONTEND_URL,
      formatAuthors: (authorsJson) => {
        const formatted = formatAuthorsForScholar(authorsJson);
        return formatted.map((a) => `${a.firstName} ${a.lastName}`.trim()).join(", ");
      },
      formatDate: formatDateForScholar,
    });
  } catch (err) {
    next(err);
  }
};
