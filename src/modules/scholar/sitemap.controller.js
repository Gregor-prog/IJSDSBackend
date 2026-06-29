import { getAllPublishedArticles, buildArticleUrl } from "./scholar.service.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";
const BASE_URL = process.env.BASE_URL ?? "https://ijsdsbackend-429660256945.europe-southwest1.run.app";

const esc = (str) =>
  String(str ?? "").replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c],
  );

/**
 * Serves dynamic XML Sitemap containing all published articles
 */
export const serveSitemap = async (req, res, next) => {
  try {
    const articles = await getAllPublishedArticles();

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${FRONTEND_URL}/papers</loc>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`;

    articles.forEach((article) => {
      const articleUrl = buildArticleUrl(article.id);
      const lastMod = new Date(article.updated_at ?? article.publication_date ?? Date.now()).toISOString();
      xml += `
  <url>
    <loc>${esc(articleUrl)}</loc>
    <lastmod>${lastMod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
    });

    xml += `\n</urlset>`;

    res.header("Content-Type", "application/xml");
    return res.status(200).send(xml);
  } catch (err) {
    next(err);
  }
};

/**
 * Serves a dynamic robots.txt that directs bots to the sitemaps
 */
export const serveRobotsTxt = async (req, res, next) => {
  try {
    const robots = `User-agent: *
Allow: /
Allow: /papers/
Allow: /uploads/

Sitemap: ${FRONTEND_URL}/sitemap.xml
Sitemap: ${BASE_URL}/sitemap.xml
`;
    res.header("Content-Type", "text/plain");
    return res.status(200).send(robots);
  } catch (err) {
    next(err);
  }
};

/**
 * Serves dynamic RSS feed containing the latest 50 published articles
 */
export const serveRssFeed = async (req, res, next) => {
  try {
    const allArticles = await getAllPublishedArticles();
    const articles = allArticles.slice(0, 50);

    let rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>International Journal for Social Work and Development Studies (IJSDS)</title>
  <link>${FRONTEND_URL}</link>
  <description>Latest published research articles from IJSDS</description>
  <language>en-us</language>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${BASE_URL}/feed/latest-articles.xml" rel="self" type="application/rss+xml" />`;

    articles.forEach((article) => {
      const articleUrl = buildArticleUrl(article.id);
      const pubDate = new Date(article.publication_date ?? article.created_at).toUTCString();
      rss += `
  <item>
    <title>${esc(article.title)}</title>
    <link>${esc(articleUrl)}</link>
    <guid isPermaLink="true">${esc(articleUrl)}</guid>
    <pubDate>${pubDate}</pubDate>
    <description>${esc(article.abstract ? article.abstract.substring(0, 300) + "..." : "")}</description>
  </item>`;
    });

    rss += `\n</channel>\n</rss>`;

    res.header("Content-Type", "application/rss+xml");
    return res.status(200).send(rss);
  } catch (err) {
    next(err);
  }
};
