import prisma from "../../config/prisma.js";

export const listArticles = async ({ status, subject_area, volume, issue }) => {
  const where = {};
  if (status) where.status = status;
  if (subject_area) where.subject_area = { contains: subject_area, mode: "insensitive" };
  if (volume) where.volume = Number(volume);
  if (issue) where.issue = Number(issue);

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
    },
    orderBy: { submission_date: "desc" },
  });
};

export const getArticle = async (id) => {
  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      submissions: {
        select: { id: true, status: true, submitted_at: true, submitter_id: true },
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
    title, abstract, keywords, authors, doi, status,
    volume, issue, page_start, page_end, subject_area,
    funding_info, conflicts_of_interest, publication_date,
    vetting_fee, processing_fee,
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
  if (conflicts_of_interest !== undefined) updateData.conflicts_of_interest = conflicts_of_interest;
  if (publication_date !== undefined) updateData.publication_date = new Date(publication_date);
  if (vetting_fee !== undefined) updateData.vetting_fee = vetting_fee;
  if (processing_fee !== undefined) updateData.processing_fee = processing_fee;

  return prisma.article.update({ where: { id }, data: updateData });
};
