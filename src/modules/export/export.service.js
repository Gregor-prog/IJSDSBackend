import prisma from "../../config/prisma.js";

// ── CSV helpers ───────────────────────────────────────────────────────────────

const csvCell = (val) => {
  const str = val == null ? "" : String(val);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
};

export const toCsv = (rows, headers) =>
  [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");

// ── Data fetchers ─────────────────────────────────────────────────────────────

const fetchSubmissions = async ({ dateFrom, dateTo, includeMetadata, includeComments }) => {
  const where = {};
  if (dateFrom) where.submitted_at = { gte: new Date(dateFrom) };
  if (dateTo) where.submitted_at = { ...where.submitted_at, lte: new Date(dateTo) };

  const rows = await prisma.submission.findMany({
    where,
    include: {
      article: { select: { title: true, subject_area: true } },
      submitter: { select: { full_name: true, email: true } },
    },
    orderBy: { submitted_at: "desc" },
  });

  return rows.map((s) => ({
    id: s.id,
    title: s.article?.title ?? "",
    submitter_name: s.submitter?.full_name ?? "",
    submitter_email: s.submitter?.email ?? "",
    status: s.status,
    submitted_at: s.submitted_at,
    ...(includeMetadata && {
      submission_type: s.submission_type,
      approved_by_editor: s.approved_by_editor,
    }),
    ...(includeComments && {
      cover_letter: s.cover_letter ?? "",
      editor_notes: s.editor_notes ?? "",
    }),
  }));
};

const fetchReviews = async ({ dateFrom, dateTo, includeComments }) => {
  const where = {};
  if (dateFrom) where.created_at = { gte: new Date(dateFrom) };
  if (dateTo) where.created_at = { ...where.created_at, lte: new Date(dateTo) };

  const rows = await prisma.review.findMany({
    where,
    include: {
      reviewer: { select: { full_name: true, email: true } },
      submission: { include: { article: { select: { title: true } } } },
    },
    orderBy: { created_at: "desc" },
  });

  return rows.map((r) => ({
    id: r.id,
    article_title: r.submission?.article?.title ?? "",
    reviewer_name: r.reviewer?.full_name ?? "",
    reviewer_email: r.reviewer?.email ?? "",
    invitation_status: r.invitation_status,
    recommendation: r.recommendation ?? "",
    submitted_at: r.submitted_at ?? "",
    deadline_date: r.deadline_date ?? "",
    ...(includeComments && {
      comments_to_author: r.comments_to_author ?? "",
      comments_to_editor: r.comments_to_editor ?? "",
    }),
  }));
};

const fetchArticles = async ({ dateFrom, dateTo, includeMetadata }) => {
  const where = {};
  if (dateFrom) where.publication_date = { gte: new Date(dateFrom) };
  if (dateTo) where.publication_date = { ...where.publication_date, lte: new Date(dateTo) };

  const rows = await prisma.article.findMany({
    where,
    orderBy: { publication_date: "desc" },
  });

  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    authors: Array.isArray(a.authors)
      ? a.authors.map((x) => x?.name ?? `${x?.first_name ?? ""} ${x?.last_name ?? ""}`.trim()).join("; ")
      : "",
    status: a.status,
    doi: a.doi ?? "",
    volume: a.volume ?? "",
    issue: a.issue ?? "",
    submission_date: a.submission_date ?? "",
    publication_date: a.publication_date ?? "",
    ...(includeMetadata && {
      subject_area: a.subject_area ?? "",
      keywords: (a.keywords ?? []).join("; "),
    }),
  }));
};

const fetchUsers = async ({ dateFrom, dateTo, includeMetadata }) => {
  const where = {};
  if (dateFrom) where.created_at = { gte: new Date(dateFrom) };
  if (dateTo) where.created_at = { ...where.created_at, lte: new Date(dateTo) };

  const rows = await prisma.profile.findMany({
    where,
    orderBy: { created_at: "desc" },
  });

  return rows.map((u) => ({
    id: u.id,
    full_name: u.full_name ?? "",
    email: u.email ?? "",
    affiliation: u.affiliation ?? "",
    role: u.role,
    is_editor: u.is_editor,
    is_reviewer: u.is_reviewer,
    created_at: u.created_at,
    ...(includeMetadata && {
      orcid_id: u.orcid_id ?? "",
      email_notifications_enabled: u.email_notifications_enabled,
    }),
  }));
};

// ── Export orchestrator ───────────────────────────────────────────────────────

export const exportData = async ({
  dataType,
  format = "csv",
  dateFrom,
  dateTo,
  includeMetadata = false,
  includeComments = false,
}) => {
  const opts = { dateFrom, dateTo, includeMetadata, includeComments };
  let rows;

  switch (dataType) {
    case "submissions": rows = await fetchSubmissions(opts); break;
    case "reviews":     rows = await fetchReviews(opts);     break;
    case "articles":    rows = await fetchArticles(opts);    break;
    case "users":       rows = await fetchUsers(opts);       break;
    default:
      throw Object.assign(new Error(`Invalid dataType: "${dataType}"`), { status: 400 });
  }

  if (!rows.length) throw Object.assign(new Error("No data found"), { status: 404 });

  const headers = Object.keys(rows[0]);
  const date = new Date().toISOString().split("T")[0];
  const filename = `${dataType}_export_${date}.csv`;

  return { csv: toCsv(rows, headers), filename, rowCount: rows.length };
};

// ── AJOL XML export ───────────────────────────────────────────────────────────

const esc = (str) =>
  String(str ?? "").replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

const formatAuthors = (authors) => {
  if (!authors) return "";
  if (typeof authors === "string") return esc(authors);
  if (Array.isArray(authors))
    return authors.map((a) =>
      typeof a === "string" ? esc(a) : esc(`${a.firstName ?? a.first_name ?? ""} ${a.lastName ?? a.last_name ?? ""}`.trim())
    ).join("; ");
  return "";
};

export const exportAjol = async (format = "xml") => {
  const articles = await prisma.article.findMany({
    where: { status: "published" },
    orderBy: { publication_date: "desc" },
  });

  if (format !== "xml") return { content: JSON.stringify(articles, null, 2), count: articles.length, format: "json" };

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<articles xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <journal>
    <journal_title>International Journal for Social Work and Development Studies</journal_title>
    <publisher>IJSDS</publisher>
  </journal>\n`;

  for (const a of articles) {
    xml += `  <article>
    <title>${esc(a.title)}</title>
    <authors>${formatAuthors(a.authors)}</authors>
    <abstract>${esc(a.abstract)}</abstract>
    <keywords>${esc((a.keywords ?? []).join(", "))}</keywords>
    <doi>${esc(a.doi)}</doi>
    <publication_date>${a.publication_date ?? a.created_at}</publication_date>
    <volume>${a.volume ?? ""}</volume>
    <issue>${a.issue ?? ""}</issue>
    <page_start>${a.page_start ?? ""}</page_start>
    <page_end>${a.page_end ?? ""}</page_end>
    <subject_area>${esc(a.subject_area)}</subject_area>
    <corresponding_author_email>${esc(a.corresponding_author_email)}</corresponding_author_email>
    <manuscript_url>${esc(a.manuscript_file_url)}</manuscript_url>
  </article>\n`;
  }

  xml += "</articles>";

  return { content: xml, count: articles.length, format: "xml" };
};
