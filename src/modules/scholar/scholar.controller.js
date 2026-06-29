import {
  getPublishedArticle,
  getAllPublishedArticles,
  formatAuthorsForScholar,
  formatDateForScholar,
  buildPdfUrl,
  buildArticleUrl,
} from "./scholar.service.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

/**
 * Render a single published article in HTML with metadata tags
 */
export const renderArticle = async (req, res, next) => {
  try {
    const { id } = req.params;
    let article;
    try {
      article = await getPublishedArticle(id);
    } catch (err) {
      if (err.status === 404) {
        // Render a clean 404 page
        return res.status(404).send(`
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
      }
      throw err;
    }

    const authors = formatAuthorsForScholar(article.authors);
    const publicationDate = formatDateForScholar(article.publication_date ?? article.created_at);
    const isoDate = new Date(article.publication_date ?? article.created_at).toISOString();
    const pdfUrl = buildPdfUrl(article);
    const articleUrl = buildArticleUrl(article.id);

    return res.render("article", {
      article,
      authors,
      publicationDate,
      isoDate,
      pdfUrl,
      articleUrl,
    });
  } catch (err) {
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
