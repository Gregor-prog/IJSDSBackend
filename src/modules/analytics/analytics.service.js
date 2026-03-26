import prisma from "../../config/prisma.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const daysBetween = (a, b) => {
  if (!a || !b) return null;
  return Math.round(Math.abs(new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
};

const avg = (nums) => {
  const valid = nums.filter((n) => n != null);
  return valid.length ? Math.round(valid.reduce((s, n) => s + n, 0) / valid.length) : null;
};

const dateFilter = (dateFrom, dateTo) => {
  const filter = {};
  if (dateFrom) filter.gte = new Date(dateFrom);
  if (dateTo) filter.lte = new Date(dateTo);
  return Object.keys(filter).length ? filter : undefined;
};

// ── Overview ──────────────────────────────────────────────────────────────────

export const getOverview = async ({ dateFrom, dateTo }) => {
  const submittedAt = dateFilter(dateFrom, dateTo);
  const submissionWhere = submittedAt ? { submitted_at: submittedAt } : {};

  // Submission counts by status
  const statusGroups = await prisma.submission.groupBy({
    by: ["status"],
    where: submissionWhere,
    _count: { status: true },
  });

  const byStatus = Object.fromEntries(
    statusGroups.map(({ status, _count }) => [status, _count.status])
  );

  const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const accepted = (byStatus.accepted ?? 0);
  const rejected = (byStatus.rejected ?? 0);
  const acceptanceRate = total > 0 ? Math.round((accepted / total) * 100) : 0;
  const rejectionRate = total > 0 ? Math.round((rejected / total) * 100) : 0;

  // Published articles
  const publishedCount = await prisma.article.count({
    where: { status: "published" },
  });

  // Average turnaround: submission → first editorial decision
  const decisionsWithSubmissions = await prisma.editorialDecision.findMany({
    select: { created_at: true, submission_id: true },
    take: 200,
    orderBy: { created_at: "desc" },
  });

  const submissionDates = decisionsWithSubmissions.length
    ? await prisma.submission.findMany({
        where: { id: { in: decisionsWithSubmissions.map((d) => d.submission_id) } },
        select: { id: true, submitted_at: true },
      })
    : [];

  const dateById = Object.fromEntries(submissionDates.map((s) => [s.id, s.submitted_at]));
  const turnarounds = decisionsWithSubmissions.map((d) =>
    daysBetween(dateById[d.submission_id], d.created_at)
  );
  const avgTurnaroundDays = avg(turnarounds);

  // Active reviewers (accepted at least one invitation)
  const activeReviewers = await prisma.review.groupBy({
    by: ["reviewer_id"],
    where: { invitation_status: "accepted" },
    _count: { reviewer_id: true },
  });

  // Monthly submission trend (last 12 months)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const recentSubmissions = await prisma.submission.findMany({
    where: { submitted_at: { gte: twelveMonthsAgo } },
    select: { submitted_at: true },
    orderBy: { submitted_at: "asc" },
  });

  const monthlyTrend = {};
  for (const s of recentSubmissions) {
    const key = s.submitted_at.toISOString().slice(0, 7); // "YYYY-MM"
    monthlyTrend[key] = (monthlyTrend[key] ?? 0) + 1;
  }

  // Fill in months with zero submissions
  const trend = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(twelveMonthsAgo);
    d.setMonth(d.getMonth() + i);
    const key = d.toISOString().slice(0, 7);
    trend.push({ month: key, count: monthlyTrend[key] ?? 0 });
  }

  return {
    submissions: { total, by_status: byStatus },
    acceptance_rate_pct: acceptanceRate,
    rejection_rate_pct: rejectionRate,
    published_articles: publishedCount,
    active_reviewers: activeReviewers.length,
    avg_turnaround_days: avgTurnaroundDays,
    monthly_trend: trend,
  };
};

// ── Reviewer performance ──────────────────────────────────────────────────────

export const getReviewerPerformance = async ({ dateFrom, dateTo }) => {
  const createdAt = dateFilter(dateFrom, dateTo);
  const where = createdAt ? { created_at: createdAt } : {};

  const reviews = await prisma.review.findMany({
    where,
    include: {
      reviewer: { select: { id: true, full_name: true, email: true, affiliation: true } },
    },
    orderBy: { created_at: "desc" },
  });

  // Group by reviewer
  const reviewerMap = {};

  for (const r of reviews) {
    if (!r.reviewer_id) continue;
    if (!reviewerMap[r.reviewer_id]) {
      reviewerMap[r.reviewer_id] = {
        reviewer_id: r.reviewer_id,
        full_name: r.reviewer?.full_name ?? "Unknown",
        email: r.reviewer?.email ?? "",
        affiliation: r.reviewer?.affiliation ?? "",
        total_invitations: 0,
        accepted: 0,
        declined: 0,
        pending: 0,
        completed: 0,
        avg_turnaround_days: null,
        recommendations: { accept: 0, minor_revisions: 0, major_revisions: 0, reject: 0 },
        on_time_rate_pct: null,
        _turnarounds: [],
        _onTime: [],
      };
    }

    const m = reviewerMap[r.reviewer_id];
    m.total_invitations++;

    if (r.invitation_status === "accepted") m.accepted++;
    else if (r.invitation_status === "declined") m.declined++;
    else m.pending++;

    if (r.submitted_at) {
      m.completed++;
      const turnaround = daysBetween(r.invitation_accepted_at ?? r.invitation_sent_at, r.submitted_at);
      if (turnaround != null) m._turnarounds.push(turnaround);

      if (r.deadline_date) {
        m._onTime.push(new Date(r.submitted_at) <= new Date(r.deadline_date));
      }
    }

    if (r.recommendation) {
      m.recommendations[r.recommendation] = (m.recommendations[r.recommendation] ?? 0) + 1;
    }
  }

  // Finalise computed fields and strip internal accumulators
  return Object.values(reviewerMap).map(({ _turnarounds, _onTime, ...m }) => ({
    ...m,
    avg_turnaround_days: avg(_turnarounds),
    on_time_rate_pct: _onTime.length
      ? Math.round((_onTime.filter(Boolean).length / _onTime.length) * 100)
      : null,
    acceptance_rate_pct: m.total_invitations
      ? Math.round((m.accepted / m.total_invitations) * 100)
      : 0,
  }));
};

// ── Editorial ─────────────────────────────────────────────────────────────────

export const getEditorialStats = async ({ dateFrom, dateTo }) => {
  const createdAt = dateFilter(dateFrom, dateTo);
  const where = createdAt ? { created_at: createdAt } : {};

  // Decision breakdown by type
  const decisionGroups = await prisma.editorialDecision.groupBy({
    by: ["decision_type"],
    where,
    _count: { decision_type: true },
  });

  const byDecisionType = Object.fromEntries(
    decisionGroups.map(({ decision_type, _count }) => [decision_type, _count.decision_type])
  );

  const totalDecisions = Object.values(byDecisionType).reduce((s, n) => s + n, 0);

  // Per-editor decision counts
  const editorGroups = await prisma.editorialDecision.groupBy({
    by: ["editor_id"],
    where,
    _count: { id: true },
  });

  const editorIds = editorGroups.map((e) => e.editor_id);
  const editors = await prisma.profile.findMany({
    where: { id: { in: editorIds } },
    select: { id: true, full_name: true, email: true },
  });

  const editorById = Object.fromEntries(editors.map((e) => [e.id, e]));

  const perEditor = editorGroups.map(({ editor_id, _count }) => ({
    editor_id,
    full_name: editorById[editor_id]?.full_name ?? "Unknown",
    email: editorById[editor_id]?.email ?? "",
    total_decisions: _count.id,
  }));

  // Average time from submission to first decision
  const decisions = await prisma.editorialDecision.findMany({
    where,
    select: { submission_id: true, created_at: true },
    orderBy: { created_at: "asc" },
  });

  // Only take the FIRST decision per submission
  const firstDecisionMap = {};
  for (const d of decisions) {
    if (!firstDecisionMap[d.submission_id]) {
      firstDecisionMap[d.submission_id] = d.created_at;
    }
  }

  const submissionIds = Object.keys(firstDecisionMap);
  const submissions = submissionIds.length
    ? await prisma.submission.findMany({
        where: { id: { in: submissionIds } },
        select: { id: true, submitted_at: true },
      })
    : [];

  const turnarounds = submissions.map((s) =>
    daysBetween(s.submitted_at, firstDecisionMap[s.id])
  );

  // Revision-to-acceptance rate
  const revisionRequests = await prisma.revisionRequest.findMany({
    where: createdAt ? { created_at: createdAt } : {},
    select: { submission_id: true },
  });

  const revisedSubmissionIds = [...new Set(revisionRequests.map((r) => r.submission_id))];

  const acceptedAfterRevision = revisedSubmissionIds.length
    ? await prisma.submission.count({
        where: { id: { in: revisedSubmissionIds }, status: "accepted" },
      })
    : 0;

  return {
    decisions: {
      total: totalDecisions,
      by_type: byDecisionType,
    },
    avg_time_to_first_decision_days: avg(turnarounds),
    per_editor: perEditor,
    revision_to_acceptance: {
      total_revision_requests: revisedSubmissionIds.length,
      accepted_after_revision: acceptedAfterRevision,
      rate_pct: revisedSubmissionIds.length
        ? Math.round((acceptedAfterRevision / revisedSubmissionIds.length) * 100)
        : 0,
    },
  };
};
