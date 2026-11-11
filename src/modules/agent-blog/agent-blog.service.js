import sanitizeHtml from "sanitize-html";
import { slugify } from "../blog/blog.service.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Posts are rendered as raw HTML on ijsds.org, so only article markup survives: no scripts,
// styles, iframes, forms or event handlers, and links/images over http(s) only.
const SANITIZE = {
  allowedTags: [
    "h2", "h3", "h4", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "sub", "sup",
    "ul", "ol", "li", "blockquote", "a", "img", "figure", "figcaption", "code", "pre",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: { a: ["href", "title", "rel", "target"], img: ["src", "alt", "title"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"] },
  allowedSchemes: ["https", "http", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    h1: "h2",
  },
  // An image whose src was rejected would otherwise be left as an empty <img>.
  exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
};

const LIMITS = { title: 200, excerpt: 500, category: 60, tag: 40, tags: 10, content: 100_000 };
export const STATUSES = ["published", "draft"];

const str = (v, field, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw httpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw httpError(400, `${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw httpError(400, `${field} is required`);
  if (s.length > max) throw httpError(400, `${field} must be at most ${max} characters`);
  return s;
};

/** Validates and cleans a create (all required fields) or update (any subset) body. */
export const cleanPostInput = (body = {}, { partial = false } = {}) => {
  const out = {};
  const title = str(body.title, "title", LIMITS.title, { required: !partial });
  if (title !== undefined) out.title = title;

  if (body.content !== undefined || !partial) {
    const raw = str(body.content, "content", LIMITS.content, { required: true });
    const content = sanitizeHtml(raw, SANITIZE).trim();
    if (!content) throw httpError(400, "content has no allowed text (use HTML such as <p>, <h2>, <ul>, <a>)");
    out.content = content;
  }

  const excerpt = str(body.excerpt, "excerpt", LIMITS.excerpt);
  if (excerpt !== undefined) out.excerpt = sanitizeHtml(excerpt, { allowedTags: [], allowedAttributes: {} });
  const category = str(body.category, "category", LIMITS.category);
  if (category !== undefined) out.category = category;

  if (body.featured_image_url !== undefined && body.featured_image_url !== null && body.featured_image_url !== "") {
    let url;
    try { url = new URL(body.featured_image_url); } catch { throw httpError(400, "featured_image_url must be a full https URL"); }
    if (url.protocol !== "https:") throw httpError(400, "featured_image_url must use https");
    out.featured_image_url = url.toString();
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > LIMITS.tags) throw httpError(400, `tags must be a list of at most ${LIMITS.tags}`);
    out.tags = [...new Set(body.tags.map((t) => str(t, "tag", LIMITS.tag)).filter(Boolean))];
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw httpError(400, `status must be one of ${STATUSES.join(", ")}`);
    out.status = body.status;
  } else if (!partial) {
    out.status = "published"; // posting is automatic; the editor reviews in the chat first
  }
  return out;
};

const SELECT = {
  id: true, title: true, excerpt: true, content: true, category: true, tags: true,
  featured_image_url: true, status: true, slug: true, published_at: true, created_at: true, updated_at: true,
};

export function makeAgentBlogService(prisma, { siteUrl = process.env.PUBLIC_SITE_URL || "https://www.ijsds.org" } = {}) {
  const withUrl = (p) => ({ ...p, url: `${siteUrl.replace(/\/$/, "")}/blog/${p.slug}` });

  // The agent may only read or change posts it created itself.
  const findOwn = async (id) => {
    const post = await prisma.blogPost.findFirst({ where: { id, created_by_agent: true }, select: SELECT });
    if (!post) throw httpError(404, "Post not found (the AI can only open posts it created)");
    return post;
  };

  return {
    async list({ limit = 20 } = {}) {
      const posts = await prisma.blogPost.findMany({
        where: { created_by_agent: true },
        select: { id: true, title: true, excerpt: true, category: true, tags: true, status: true, slug: true, published_at: true, created_at: true },
        orderBy: { created_at: "desc" },
        take: limit,
      });
      return { posts: posts.map(withUrl) };
    },

    async get(id) {
      return withUrl(await findOwn(id));
    },

    async create(body) {
      const data = cleanPostInput(body);
      let slug = slugify(data.title) || "post";
      if (await prisma.blogPost.findUnique({ where: { slug }, select: { id: true } })) slug = `${slug}-${Date.now()}`;
      const post = await prisma.blogPost.create({
        data: {
          ...data,
          tags: data.tags ?? [],
          slug,
          author_id: process.env.AGENT_BLOG_AUTHOR_ID || null,
          created_by_agent: true,
          published_at: data.status === "published" ? new Date() : null,
        },
        select: SELECT,
      });
      return withUrl(post);
    },

    async update(id, body) {
      const current = await findOwn(id);
      const data = cleanPostInput(body, { partial: true });
      if (!Object.keys(data).length) throw httpError(400, "Nothing to update");
      // The slug (and so the public link) stays fixed once created, even if the title changes.
      if (data.status === "published" && !current.published_at) data.published_at = new Date();
      if (data.status === "draft") data.published_at = null;
      const post = await prisma.blogPost.update({ where: { id }, data, select: SELECT });
      return withUrl(post);
    },
  };
}
