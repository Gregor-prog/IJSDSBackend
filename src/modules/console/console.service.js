/**
 * Read-only, journal-wide numbers for the Parakletus admin console.
 * Explicit selects only: no review text, cover letters, files, emails,
 * tokens or raw payment payloads leave this module.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const countBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._count._all]));

export function makeConsoleService(db) {
  async function summary() {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * DAY_MS);

    const [
      submissionsByStatus,
      submissions30d,
      reviewsPendingInvite,
      reviewsInProgress,
      reviewsOverdue,
      reviewsSubmitted30d,
      articlesPublished,
      articlesPublished30d,
      crossrefByStatus,
      authors,
      reviewers,
      editors,
      applicationsPending,
      manuscriptsByState,
      payments30d,
      paymentsNeedingReview,
    ] = await Promise.all([
      db.submission.groupBy({ by: ["status"], _count: { _all: true } }),
      db.submission.count({ where: { submitted_at: { gte: since30d } } }),
      db.review.count({ where: { invitation_status: "pending" } }),
      db.review.count({ where: { invitation_status: "accepted", submitted_at: null } }),
      db.review.count({ where: { invitation_status: "accepted", submitted_at: null, deadline_date: { lt: now } } }),
      db.review.count({ where: { submitted_at: { gte: since30d } } }),
      db.article.count({ where: { status: "published" } }),
      db.article.count({ where: { status: "published", publication_date: { gte: since30d } } }),
      db.article.groupBy({ by: ["crossref_status"], where: { status: "published" }, _count: { _all: true } }),
      db.profile.count({ where: { role: "author" } }),
      db.profile.count({ where: { OR: [{ is_reviewer: true }, { role: "reviewer" }] } }),
      db.profile.count({ where: { OR: [{ is_editor: true }, { role: { in: ["editor", "admin"] } }] } }),
      db.reviewerApplication.count({ where: { status: "PENDING" } }),
      db.manuscript.groupBy({ by: ["current_state"], _count: { _all: true } }),
      db.paymentLedger.aggregate({
        where: { status: "success", created_at: { gte: since30d } },
        _count: { _all: true },
        _sum: { amount_naira: true },
      }),
      db.paymentLedger.count({ where: { status: "needs_review" } }),
    ]);

    const crossref = countBy(crossrefByStatus, "crossref_status");
    return {
      submissions: { byStatus: countBy(submissionsByStatus, "status"), last30d: submissions30d },
      reviews: {
        awaitingResponse: reviewsPendingInvite,
        inProgress: reviewsInProgress,
        overdue: reviewsOverdue,
        submitted30d: reviewsSubmitted30d,
      },
      articles: {
        published: articlesPublished,
        published30d: articlesPublished30d,
        crossref: {
          registered: crossref.REGISTERED ?? 0,
          pending: crossref.PENDING ?? 0,
          failed: crossref.FAILED ?? 0,
          notDeposited: crossref.null ?? 0,
        },
      },
      people: { authors, reviewers, editors, reviewerApplicationsPending: applicationsPending },
      ijsds2: {
        manuscriptsByState: countBy(manuscriptsByState, "current_state"),
        payments30d: { count: payments30d._count._all, naira: Number(payments30d._sum.amount_naira ?? 0) },
        paymentsNeedingReview,
      },
      generatedAt: now.toISOString(),
    };
  }

  async function submissions({ page, limit, status }) {
    const now = new Date();
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      db.submission.findMany({
        where,
        select: {
          id: true,
          status: true,
          submission_type: true,
          submitted_at: true,
          updated_at: true,
          article: { select: { title: true } },
          submitter: { select: { full_name: true, affiliation: true } },
          reviews: { select: { invitation_status: true, submitted_at: true, deadline_date: true } },
        },
        orderBy: { submitted_at: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.submission.count({ where }),
    ]);

    return {
      submissions: rows.map(({ article, submitter, reviews, ...s }) => ({
        ...s,
        title: article?.title ?? null,
        author: submitter?.full_name ?? null,
        affiliation: submitter?.affiliation ?? null,
        reviews: {
          total: reviews.length,
          submitted: reviews.filter((r) => r.submitted_at).length,
          overdue: reviews.filter(
            (r) => r.invitation_status === "accepted" && !r.submitted_at && r.deadline_date && r.deadline_date < now,
          ).length,
        },
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  return { summary, submissions };
}
