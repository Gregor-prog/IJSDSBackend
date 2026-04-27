import prisma from "../../config/prisma.js";
import sendEmail from "../email/email.service.js";

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
  if (doi) where.doi = doi;

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
      indexing_fee: true,
      manuscript_file_url: true,
    },
    orderBy: { submission_date: "desc" },
  });
};

export const getArticle = async (id) => {
  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      submissions: {
        select: {
          id: true,
          status: true,
          submitted_at: true,
          submitter_id: true,
          manuscript_file_url: true,
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

export const updateArticle = async (id, data) => {
  const article = await prisma.article.findUnique({ where: { id } });

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
    indexing_fee,
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
  if (indexing_fee !== undefined) updateData.indexing_fee = indexing_fee;

  const updated = await prisma.article.update({
    where: { id },
    data: updateData,
    include: {
      submissions: {
        take: 1,
        orderBy: { submitted_at: "desc" },
        include: {
          submitter: { select: { id: true, full_name: true, email: true } },
        },
      },
    },
  });

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
  }

  return updated;
};
