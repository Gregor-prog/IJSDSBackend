import prisma from "../../config/prisma.js";
import sendEmail from "../email/email.service.js";
import { enqueueCrossRefDeposit } from "../../lib/queue.js";
import { notifySearchEngines } from "../scholar/indexing.service.js";
import { buildArticleUrl } from "../scholar/scholar.service.js";

// Explicit select of only columns that exist in the current DB.
// Excludes vetting_currency, vetting_reference, processing_currency,
// processing_reference, indexing_fee which are in the schema but not yet migrated.
const SAFE_ARTICLE_SELECT = {
  id: true,
  title: true,
  abstract: true,
  keywords: true,
  authors: true,
  corresponding_author_email: true,
  manuscript_file_url: true,
  submission_date: true,
  publication_date: true,
  doi: true,
  crossrefDoi: true,
  status: true,
  volume: true,
  issue: true,
  page_start: true,
  page_end: true,
  subject_area: true,
  funding_info: true,
  conflicts_of_interest: true,
  vetting_fee: true,
  processing_fee: true,
  created_at: true,
  updated_at: true,
};

export const listArticles = async ({
  status,
  subject_area,
  volume,
  issue,
  doi,
}) => {
  const where = {};
  if (status) where.status = status;
  if (subject_area)
    where.subject_area = { contains: subject_area, mode: "insensitive" };
  if (volume) where.volume = Number(volume);
  if (issue) where.issue = Number(issue);
  if (doi) where.OR = [{ doi }, { crossrefDoi: doi }];

  return prisma.article.findMany({
    where,
    select: {
      id: true,
      title: true,
      abstract: true,
      keywords: true,
      authors: true,
      corresponding_author_email: true,
      doi: true,
      crossrefDoi: true,
      status: true,
      volume: true,
      issue: true,
      page_start: true,
      page_end: true,
      subject_area: true,
      publication_date: true,
      submission_date: true,
      vetting_fee: true,
      processing_fee: true,
      manuscript_file_url: true,
      // Editors need the submission id to manage files/authors from the article list
      submissions: {
        select: { id: true },
        take: 1,
        orderBy: { submitted_at: "desc" },
      },
    },
    orderBy: { submission_date: "desc" },
  });
};

export const getArticle = async (id) => {
  const article = await prisma.article.findUnique({
    where: { id },
    select: {
      ...SAFE_ARTICLE_SELECT,
      submissions: {
        select: {
          id: true,
          status: true,
          submitted_at: true,
          submitter_id: true,
        },
      },
      file_versions: {
        where: { is_archived: false },
        orderBy: { version_number: "desc" },
      },
    },
  });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  return article;
};

export const deleteArticle = async (id, requester) => {
  const article = await prisma.article.findUnique({
    where: { id },
    select: {
      id: true,
      submissions: { select: { id: true, submitter_id: true, status: true } },
    },
  });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  const isEditorOrAdmin =
    requester.role === "editor" || requester.role === "admin" ||
    requester.is_editor || requester.is_admin;
  const submission = article.submissions?.[0];
  const isOwnPending = submission?.submitter_id === requester.id && submission?.status === "submitted";

  if (!isEditorOrAdmin && !isOwnPending) {
    const err = new Error("You do not have permission to delete this article");
    err.status = 403;
    throw err;
  }

  const submissionIds = article.submissions.map((s) => s.id);

  // workflow_audit_log may not exist in all DB environments — delete separately
  // so a missing table does not abort the whole transaction
  if (submissionIds.length > 0) {
    await prisma.workflowAuditLog.deleteMany({ where: { submission_id: { in: submissionIds } } })
      .catch(() => {});
  }

  await prisma.$transaction([
    prisma.discussionMessage.deleteMany({ where: { thread: { submission_id: { in: submissionIds } } } }),
    prisma.discussionThread.deleteMany({ where: { submission_id: { in: submissionIds } } }),
    prisma.review.deleteMany({ where: { submission_id: { in: submissionIds } } }),
    prisma.editorialDecision.deleteMany({ where: { submission_id: { in: submissionIds } } }),
    prisma.revisionRequest.deleteMany({ where: { submission_id: { in: submissionIds } } }),
    prisma.rejectionMessage.deleteMany({ where: { submission_id: { in: submissionIds } } }),
    prisma.submission.deleteMany({ where: { article_id: id } }),
    prisma.fileVersion.deleteMany({ where: { article_id: id } }),
    prisma.article.delete({ where: { id }, select: { id: true } }),
  ]);
};

export const updateArticle = async (id, data) => {
  const article = await prisma.article.findUnique({ where: { id }, select: { id: true, status: true } });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  const {
    title,
    abstract,
    keywords,
    authors,
    doi,
    status,
    volume,
    issue,
    page_start,
    page_end,
    subject_area,
    funding_info,
    conflicts_of_interest,
    publication_date,
    vetting_fee,
    processing_fee,
  } = data;

  const updateData = {};
  if (title !== undefined) updateData.title = title;
  if (abstract !== undefined) updateData.abstract = abstract;
  if (keywords !== undefined) updateData.keywords = keywords;
  if (authors !== undefined) updateData.authors = authors;
  if (doi !== undefined) updateData.doi = doi;
  if (status !== undefined) updateData.status = status;
  if (volume !== undefined) updateData.volume = volume;
  if (issue !== undefined) updateData.issue = issue;
  if (page_start !== undefined) updateData.page_start = page_start;
  if (page_end !== undefined) updateData.page_end = page_end;
  if (subject_area !== undefined) updateData.subject_area = subject_area;
  if (funding_info !== undefined) updateData.funding_info = funding_info;
  if (conflicts_of_interest !== undefined)
    updateData.conflicts_of_interest = conflicts_of_interest;
  if (publication_date !== undefined)
    updateData.publication_date = new Date(publication_date);
  if (vetting_fee !== undefined) updateData.vetting_fee = vetting_fee;
  if (processing_fee !== undefined) updateData.processing_fee = processing_fee;

  const updated = await prisma.article.update({
    where: { id },
    data: updateData,
    select: {
      ...SAFE_ARTICLE_SELECT,
      submissions: {
        take: 1,
        orderBy: { submitted_at: "desc" },
        select: {
          id: true,
          submitter: { select: { id: true, full_name: true, email: true } },
        },
      },
    },
  });

  // Register CrossRef DOI on first publish (only if vol+issue are set and no DOI yet)
  if (status === "published" && article.status !== "published" && !updated.crossrefDoi) {
    enqueueCrossRefDeposit(id, "register")
      .then(({ jobId }) => console.log(`[crossref] DOI registration queued — job ${jobId} for article ${id}`))
      .catch((err) => console.error(`[crossref] Failed to queue DOI registration for article ${id}:`, err.message));
  }

  // Send both publication emails when status transitions to published
  if (status === "published" && article.status !== "published") {
    const submitter = updated.submissions?.[0]?.submitter;
    if (submitter?.email) {
      const emailData = {
        to: submitter.email,
        recipientId: submitter.id,
        name: submitter.full_name ?? "Author",
        title: updated.title,
        doi: updated.doi ?? null,
        volume: updated.volume ?? null,
        issue: updated.issue ?? null,
        publicationDate: (
          updated.publication_date ?? new Date()
        ).toLocaleDateString("en-GB"),
      };

      sendEmail("article_published", emailData).catch((err) =>
        console.error("[email] article_published:", err.message),
      );

      sendEmail("article_published_celebratory", emailData).catch((err) =>
        console.error("[email] article_published_celebratory:", err.message),
      );
    }

    // Notify search engines (Google Indexing API + IndexNow) of the new article
    const articleUrl = buildArticleUrl(id);
    notifySearchEngines(articleUrl).catch((err) =>
      console.error("[indexing] Failed to notify search engines:", err.message),
    );
  }

  return updated;
};

export const rePingArticle = async (id) => {
  const article = await prisma.article.findUnique({ where: { id }, select: { id: true, status: true } });

  if (!article) {
    const err = new Error("Article not found");
    err.status = 404;
    throw err;
  }

  if (article.status !== "published") {
    const err = new Error("Cannot ping indexing API for an unpublished article");
    err.status = 400;
    throw err;
  }

  const articleUrl = buildArticleUrl(id);
  await notifySearchEngines(articleUrl);
  return { success: true, url: articleUrl };
};

export const rePingAllArticles = async () => {
  const articles = await prisma.article.findMany({
    where: { status: "published" },
    select: { id: true }
  });

  console.log(`[indexing] Queueing manual bulk re-ping for ${articles.length} articles`);
  
  // Ping all in parallel
  const promises = articles.map(async (art) => {
    const url = buildArticleUrl(art.id);
    return notifySearchEngines(url);
  });

  await Promise.allSettled(promises);
  return { success: true, count: articles.length };
};

