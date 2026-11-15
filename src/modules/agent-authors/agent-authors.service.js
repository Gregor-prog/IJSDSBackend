/**
 * Read-only directory of IJSDS authors for the outreach assistant: everyone who has submitted
 * a paper, plus the corresponding and co-authors named on those papers. Its purpose is to keep
 * outreach from re-contacting people who already know the journal.
 *
 * Deliberately narrow: name, email, affiliation, role, paper counts and dates. No manuscript
 * titles, review details, decisions, payments, reviewers or editors.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (e) => String(e ?? "").trim().toLowerCase();

const authorName = (a) =>
  (a?.name ?? [a?.first_name ?? a?.firstName ?? a?.given, a?.last_name ?? a?.lastName ?? a?.family].filter(Boolean).join(" ")) || null;

export function makeAuthorDirectory(prisma) {
  /** Builds the whole directory. The journal has hundreds of submissions, so this stays in memory. */
  const build = async () => {
    const [submissions, optedOutProfiles, unsubscribed] = await Promise.all([
      prisma.submission.findMany({
        select: {
          article_id: true,
          submitted_at: true,
          submitter: { select: { email: true, full_name: true, affiliation: true } },
          article: { select: { status: true, corresponding_author_email: true, authors: true } },
        },
      }),
      prisma.profile.findMany({
        where: { email: { not: null }, OR: [{ email_notifications_enabled: false }, { blog_emails: false }] },
        select: { email: true },
      }),
      prisma.blogSubscriber.findMany({ where: { status: "unsubscribed" }, select: { email: true } }),
    ]);
    const optedOut = new Set([...optedOutProfiles, ...unsubscribed].map((r) => norm(r.email)));

    const byEmail = new Map();
    const add = (rawEmail, role, sub, { name, affiliation } = {}) => {
      const email = norm(rawEmail);
      if (!EMAIL_RE.test(email)) return;
      let entry = byEmail.get(email);
      if (!entry) {
        entry = { email, name: null, affiliation: null, roles: new Set(), papers: new Set(), published: new Set(), first: null, last: null };
        byEmail.set(email, entry);
      }
      entry.name ??= name || null;
      entry.affiliation ??= affiliation || null;
      entry.roles.add(role);
      const paper = sub.article_id ?? sub.submitted_at?.toISOString();
      entry.papers.add(paper);
      if (sub.article?.status === "published") entry.published.add(paper);
      const at = sub.submitted_at;
      if (at && (!entry.first || at < entry.first)) entry.first = at;
      if (at && (!entry.last || at > entry.last)) entry.last = at;
    };

    for (const sub of submissions) {
      if (sub.submitter) add(sub.submitter.email, "submitter", sub, { name: sub.submitter.full_name, affiliation: sub.submitter.affiliation });
      const people = Array.isArray(sub.article?.authors) ? sub.article.authors : [];
      const corresponding = norm(sub.article?.corresponding_author_email);
      for (const a of people) {
        if (!a || typeof a !== "object") continue;
        const role = norm(a.email) === corresponding ? "corresponding_author" : "co_author";
        add(a.email, role, sub, { name: authorName(a), affiliation: a.affiliation });
      }
      if (corresponding) add(corresponding, "corresponding_author", sub);
    }

    return [...byEmail.values()]
      .map((e) => ({
        email: e.email,
        name: e.name,
        affiliation: e.affiliation,
        roles: [...e.roles].sort(),
        papers_submitted: e.papers.size,
        papers_published: e.published.size,
        first_submitted_at: e.first?.toISOString() ?? null,
        last_submitted_at: e.last?.toISOString() ?? null,
        email_opt_out: optedOut.has(e.email),
      }))
      .sort((a, b) => (b.last_submitted_at ?? "").localeCompare(a.last_submitted_at ?? ""));
  };

  return {
    /** Paged list, newest submitters first. `q` matches name, email or affiliation. */
    async list({ q, since, limit = 100, offset = 0 } = {}) {
      let all = await build();
      const needle = String(q ?? "").trim().toLowerCase();
      if (needle) all = all.filter((a) => [a.email, a.name, a.affiliation].some((v) => v && v.toLowerCase().includes(needle)));
      const sinceDate = since ? new Date(since) : null;
      if (sinceDate && !Number.isNaN(sinceDate.getTime())) all = all.filter((a) => a.last_submitted_at && a.last_submitted_at >= sinceDate.toISOString());
      const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
      const off = Math.max(Number.parseInt(offset, 10) || 0, 0);
      return { total: all.length, offset: off, limit: lim, authors: all.slice(off, off + lim) };
    },

    /** For each email: is this person already an IJSDS author? Unknown addresses return is_author false. */
    async check(emails) {
      if (!Array.isArray(emails) || emails.length === 0) throw Object.assign(new Error("emails must be a non-empty array"), { status: 400 });
      if (emails.length > 1000) throw Object.assign(new Error("At most 1000 emails per check"), { status: 400 });
      const index = new Map((await build()).map((a) => [a.email, a]));
      return {
        results: emails.map((raw) => {
          const email = norm(raw);
          const a = index.get(email);
          return a
            ? { email, is_author: true, papers_submitted: a.papers_submitted, last_submitted_at: a.last_submitted_at, email_opt_out: a.email_opt_out }
            : { email, is_author: false };
        }),
      };
    },
  };
}
