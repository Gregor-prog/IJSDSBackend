import crypto from "node:crypto";
import { Resend } from "resend";
import prisma from "../../config/prisma.js";
import sendEmail, { escapeTemplateData } from "../email/email.service.js";
import { templates } from "../email/email.templates.js";

/**
 * Email announcements of new blog posts.
 *
 * Recipients: registered users with email notifications on and blog_emails on, plus confirmed
 * (double opt-in) blog subscribers. Each post is announced once, the first time it is published,
 * whether an editor or the AI writer publishes it. Every email carries a signed unsubscribe link
 * and the one-click List-Unsubscribe headers that Gmail and Yahoo require of bulk senders.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status });

const SITE_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";
const API_URL = process.env.PUBLIC_API_URL ?? "https://ijsds-database-ftb5hpfrfecegtbz.switzerlandnorth-01.azurewebsites.net";
const FROM = "IJSDS Blog <noreply@ijsds.org>";
const REPLY_TO = "editor@ijsds.org";
const BATCH_SIZE = 100; // Resend's batch limit
const BATCH_PAUSE_MS = 600; // stays under Resend's default 2 requests/second
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normaliseEmail = (raw) => String(raw ?? "").trim().toLowerCase();

// ── Signed links ────────────────────────────────────────────────────────────────
// Stateless: the token is the email plus an HMAC, so links never expire and need no table.

const linkSecret = () => {
  const secret = process.env.EMAIL_LINK_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("EMAIL_LINK_SECRET (or JWT_SECRET) is not set");
  return secret;
};

const sign = (purpose, email) =>
  crypto.createHmac("sha256", linkSecret()).update(`${purpose}:${email}`).digest("base64url").slice(0, 32);

export const makeToken = (purpose, email) => `${Buffer.from(email).toString("base64url")}.${sign(purpose, email)}`;

/** Returns the email a token was issued for, or null if it was tampered with. */
export const readToken = (purpose, token) => {
  const [encoded, sig] = String(token ?? "").split(".");
  if (!encoded || !sig) return null;
  let email;
  try { email = Buffer.from(encoded, "base64url").toString("utf8"); } catch { return null; }
  const expected = sign(purpose, email);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? email : null;
};

export const unsubscribeUrl = (email) => `${API_URL}/api/blog/unsubscribe?token=${makeToken("unsubscribe", email)}`;
const confirmUrl = (email) => `${API_URL}/api/blog/subscribe/confirm?token=${makeToken("confirm", email)}`;

// ── Subscribe / confirm / unsubscribe ───────────────────────────────────────────

/** Starts a double opt-in. The reply never reveals whether the address was already on the list. */
export const subscribe = async ({ email: rawEmail, name } = {}) => {
  const email = normaliseEmail(rawEmail);
  if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, "Enter a valid email address.");
  const existing = await prisma.blogSubscriber.findUnique({ where: { email } });
  if (existing?.status === "active") return { ok: true };
  await prisma.blogSubscriber.upsert({
    where: { email },
    create: { email, name: name ? String(name).trim().slice(0, 120) : null },
    update: { status: "pending", unsubscribed_at: null },
  });
  await sendEmail("blog_subscribe_confirm", { to: email, confirmUrl: confirmUrl(email) });
  return { ok: true };
};

export const confirmSubscription = async (token) => {
  const email = readToken("confirm", token);
  if (!email) return false;
  const row = await prisma.blogSubscriber.findUnique({ where: { email } });
  if (!row) return false;
  if (row.status !== "active") {
    await prisma.blogSubscriber.update({ where: { email }, data: { status: "active", confirmed_at: new Date(), unsubscribed_at: null } });
  }
  // An account holder who subscribes is opting back in on their profile too.
  await prisma.profile.updateMany({ where: { email: { equals: email, mode: "insensitive" } }, data: { blog_emails: true } });
  return true;
};

/** Stops blog emails for the address, whether it belongs to an account, a subscriber or both. */
export const unsubscribe = async (token) => {
  const email = readToken("unsubscribe", token);
  if (!email) return false;
  await prisma.blogSubscriber.updateMany({ where: { email, status: { not: "unsubscribed" } }, data: { status: "unsubscribed", unsubscribed_at: new Date() } });
  await prisma.profile.updateMany({ where: { email: { equals: email, mode: "insensitive" } }, data: { blog_emails: false } });
  return true;
};

// ── Recipients ──────────────────────────────────────────────────────────────────

/** Account holders who allow email, then confirmed subscribers; one entry per address. */
export const listRecipients = async () => {
  const [profiles, subscribers] = await Promise.all([
    prisma.profile.findMany({
      where: { email: { not: null }, email_notifications_enabled: true, blog_emails: true },
      select: { email: true },
    }),
    prisma.blogSubscriber.findMany({ where: { status: "active" }, select: { email: true } }),
  ]);
  const seen = new Map();
  for (const p of profiles) {
    const email = normaliseEmail(p.email);
    if (EMAIL_RE.test(email) && !seen.has(email)) seen.set(email, "account");
  }
  for (const s of subscribers) {
    const email = normaliseEmail(s.email);
    if (EMAIL_RE.test(email) && !seen.has(email)) seen.set(email, "subscriber");
  }
  return [...seen].map(([email, kind]) => ({ email, kind }));
};

const REASONS = {
  account: "You're receiving this because you have an account with IJSDS.",
  subscriber: "You're receiving this because you subscribed to the IJSDS Blog.",
};

/** One Resend batch item per recipient, each with its own unsubscribe link and headers. */
export const buildMessages = (post, recipients) => {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const imageUrl = post.featured_image_url && /^https:\/\//i.test(post.featured_image_url) ? post.featured_image_url : "";
  const base = { title: post.title, excerpt: post.excerpt ?? "", category: post.category ?? "" };
  const { subject } = templates.blog_new_post({ ...base, url, imageUrl, unsubscribeUrl: "", reason: "" });
  return recipients.map(({ email, kind }) => {
    const unsub = unsubscribeUrl(email);
    const { html } = templates.blog_new_post({ ...escapeTemplateData({ ...base, url, imageUrl, unsubscribeUrl: unsub }), reason: REASONS[kind] });
    return {
      from: FROM,
      replyTo: REPLY_TO,
      to: email,
      subject,
      html,
      headers: {
        "List-Unsubscribe": `<${unsub}>, <mailto:${REPLY_TO}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  });
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Emails everyone about a newly published post, once. Safe to call on every publish: the
 * subscribers_notified_at claim means only the first call for a post sends anything.
 * `client` is injectable for tests; without RESEND_API_KEY it only logs.
 */
export const announceBlogPost = async (postId, { client, pauseMs = BATCH_PAUSE_MS } = {}) => {
  const { count } = await prisma.blogPost.updateMany({
    where: { id: postId, status: "published", subscribers_notified_at: null },
    data: { subscribers_notified_at: new Date() },
  });
  if (count !== 1) return { sent: 0, failed: 0, skipped: true };

  const post = await prisma.blogPost.findUnique({
    where: { id: postId },
    select: { id: true, title: true, excerpt: true, category: true, slug: true, featured_image_url: true },
  });
  const recipients = await listRecipients();
  const resend = client ?? (process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null);
  if (!resend) {
    console.warn(`[blog-email] RESEND_API_KEY not set; not announcing "${post.title}" to ${recipients.length} recipients`);
    return { sent: 0, failed: recipients.length, skipped: false };
  }

  const messages = buildMessages(post, recipients);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE);
    let status = "sent";
    try {
      const { error } = await resend.batch.send(chunk);
      if (error) throw new Error(error.message ?? JSON.stringify(error));
      sent += chunk.length;
    } catch (err) {
      status = "failed";
      failed += chunk.length;
      console.error(`[blog-email] batch ${i / BATCH_SIZE + 1} failed for "${post.title}":`, err.message);
    }
    await prisma.emailNotification.createMany({
      data: chunk.map((m) => ({
        recipient_email: m.to,
        subject: m.subject,
        body: `${SITE_URL}/blog/${post.slug}`,
        notification_type: "blog_new_post",
        status,
      })),
    }).catch((e) => console.error("[blog-email] could not log batch:", e.message));
    if (i + BATCH_SIZE < messages.length) await pause(pauseMs);
  }
  console.log(`[blog-email] "${post.title}": ${sent} sent, ${failed} failed, ${recipients.length} recipients`);
  return { sent, failed, skipped: false };
};

/** Fire-and-forget wrapper for publish paths: the post is live whatever happens to the email. */
export const announceInBackground = (postId) => {
  announceBlogPost(postId).catch((e) => console.error("[blog-email] announcement failed:", postId, e.message));
};
