import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
  allowExitOnIdle: false,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e: any) {
      // Don't retry constraint/validation errors — only connection errors
      if (e.message?.includes('Foreign key') || e.message?.includes('Unique constraint') || e.message?.includes('constraint')) throw e;
      if (i === retries - 1) throw e;
      await sleep(delay);
    }
  }
  throw new Error('unreachable');
}

const toNull = (v: any) =>
  v === '' || v === 'null' || v === null || v === undefined ? null : v;

const toDate = (v: any): Date | null => {
  const n = toNull(v);
  return n ? new Date(n) : null;
};

const toBool = (v: any): boolean =>
  v === true || v === 'true' || v === 't' || v === '1';

const toInt = (v: any): number | null => {
  const n = toNull(v);
  if (n === null) return null;
  const i = parseInt(n, 10);
  return isNaN(i) ? null : i;
};

const toBigInt = (v: any): bigint | null => {
  const n = toNull(v);
  if (n === null) return null;
  try { return BigInt(n); } catch { return null; }
};

const toJson = (v: any): any => {
  const n = toNull(v);
  if (n === null) return null;
  if (typeof n === 'object') return n;
  try { return JSON.parse(n); } catch { return n; }
};

const toStringArray = (v: any): string[] => {
  const n = toNull(v);
  if (!n) return [];
  if (Array.isArray(n)) return n;
  if (typeof n === 'string') {
    if (n === '[]' || n === '{}') return [];
    // PostgreSQL array format: {val1,val2}
    if (n.startsWith('{') && n.endsWith('}'))
      return n.slice(1, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    try { return JSON.parse(n); } catch { return []; }
  }
  return [];
};

function readCsv(filename: string): any[] | null {
  const filePath = path.join(__dirname, 'data', filename);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

// ─── Seeders ──────────────────────────────────────────────────────────────────

async function seedProfiles(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.profile.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          full_name: toNull(r.full_name),
          email: toNull(r.email),
          affiliation: toNull(r.affiliation),
          orcid_id: toNull(r.orcid_id),
          bio: toNull(r.bio),
          is_editor: toBool(r.is_editor),
          is_reviewer: toBool(r.is_reviewer),
          is_admin: toBool(r.is_admin),
          email_notifications_enabled: r.email_notifications_enabled !== undefined ? toBool(r.email_notifications_enabled) : true,
          deadline_reminder_days: toInt(r.deadline_reminder_days) ?? 3,
          request_reviewer: toBool(r.request_reviewer),
          request_editor: toBool(r.request_editor),
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
          role: 'author',
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ profiles [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedPartners(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.partner.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          name: r.name,
          logo_url: toNull(r.logo_url),
          website_url: toNull(r.website_url),
          description: toNull(r.description),
          is_active: toBool(r.is_active ?? true),
          display_order: toInt(r.display_order) ?? 0,
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ partners [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedSystemSettings(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.systemSetting.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          setting_key: r.setting_key,
          setting_value: toJson(r.setting_value),
          description: toNull(r.description),
          updated_by: toNull(r.updated_by),
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ system_settings [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedArticles(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.article.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          title: r.title,
          abstract: r.abstract,
          keywords: toStringArray(r.keywords),
          authors: toJson(r.authors) ?? [],
          corresponding_author_email: r.corresponding_author_email,
          manuscript_file_url: toNull(r.manuscript_file_url),
          submission_date: toDate(r.submission_date),
          publication_date: toDate(r.publication_date),
          doi: toNull(r.doi),
          status: (toNull(r.status) ?? 'draft') as any,
          volume: toInt(r.volume),
          issue: toInt(r.issue),
          page_start: toInt(r.page_start),
          page_end: toInt(r.page_end),
          subject_area: toNull(r.subject_area),
          funding_info: toNull(r.funding_info),
          conflicts_of_interest: toNull(r.conflicts_of_interest),
          vetting_fee: toBool(r.vetting_fee),
          processing_fee: toBool(r.Processing_fee ?? r.processing_fee),
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ articles [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedSubmissions(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.submission.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          article_id: toNull(r.article_id),
          submitter_id: toNull(r.submitter_id),
          submission_type: (toNull(r.submission_type) ?? 'new') as any,
          cover_letter: toNull(r.cover_letter),
          reviewer_suggestions: toNull(r.reviewer_suggestions),
          status: (toNull(r.status) ?? 'submitted') as any,
          editor_notes: toNull(r.editor_notes),
          submitted_at: toDate(r.submitted_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
          approved_by_editor: toBool(r.approved_by_editor),
          approved_at: toDate(r.approved_at),
          approved_by: toNull(r.approved_by),
          vetting_fee: toBool(r.vetting_fee),
          processing_fee: toBool(r.processing_fee),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ submissions [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedReviews(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.review.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          submission_id: toNull(r.submission_id),
          reviewer_id: toNull(r.reviewer_id),
          recommendation: toNull(r.recommendation) as any,
          comments_to_author: toNull(r.comments_to_author),
          comments_to_editor: toNull(r.comments_to_editor),
          review_file_url: toNull(r.review_file_url),
          submitted_at: toDate(r.submitted_at),
          deadline_date: toDate(r.deadline_date),
          conflict_of_interest_declared: toBool(r.conflict_of_interest_declared),
          conflict_of_interest_details: toNull(r.conflict_of_interest_details),
          review_round: toInt(r.review_round) ?? 1,
          invitation_sent_at: toDate(r.invitation_sent_at),
          invitation_accepted_at: toDate(r.invitation_accepted_at),
          invitation_status: (toNull(r.invitation_status) ?? 'pending') as any,
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ reviews [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedFileVersions(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.fileVersion.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          article_id: r.article_id,
          file_url: r.file_url,
          file_name: r.file_name,
          file_type: r.file_type,
          version_number: toInt(r.version_number) ?? 1,
          uploaded_by: r.uploaded_by,
          file_size: toBigInt(r.file_size),
          file_description: toNull(r.file_description),
          is_supplementary: toBool(r.is_supplementary),
          is_archived: toBool(r.is_archived),
          created_at: toDate(r.created_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ file_versions [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedNotifications(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.notification.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          user_id: r.user_id,
          title: r.title,
          message: r.message,
          type: toNull(r.type) ?? 'info',
          read: toBool(r.read),
          created_at: toDate(r.created_at) ?? new Date(),
          updated_at: toDate(r.updated_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ notifications [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function seedWorkflowAuditLog(records: any[]) {
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      await withRetry(() => prisma.workflowAuditLog.upsert({
        where: { id: r.id },
        update: {},
        create: {
          id: r.id,
          submission_id: r.submission_id,
          old_status: toNull(r.old_status),
          new_status: r.new_status,
          changed_by: toNull(r.changed_by),
          change_reason: toNull(r.change_reason),
          metadata: toJson(r.metadata) ?? {},
          created_at: toDate(r.created_at) ?? new Date(),
        },
      }));
      ok++;
      await sleep(150);
    } catch (e: any) {
      console.warn(`  ⚠ workflow_audit_log [${r.id}]: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const steps: Array<{ file: string; label: string; fn: (r: any[]) => Promise<{ ok: number; fail: number }> }> = [
    { file: 'profiles.csv',          label: 'profiles',           fn: seedProfiles },
    { file: 'partners.csv',          label: 'partners',           fn: seedPartners },
    { file: 'settings.csv',          label: 'system_settings',    fn: seedSystemSettings },
    { file: 'articles.csv',          label: 'articles',           fn: seedArticles },
    { file: 'submissions.csv',       label: 'submissions',        fn: seedSubmissions },
    { file: 'reviews.csv',           label: 'reviews',            fn: seedReviews },
    { file: 'file_versions.csv',     label: 'file_versions',      fn: seedFileVersions },
    { file: 'notifications.csv',     label: 'notifications',      fn: seedNotifications },
    { file: 'workflow_audit_log.csv',label: 'workflow_audit_log', fn: seedWorkflowAuditLog },
  ];

  for (const step of steps) {
    const records = readCsv(step.file);
    if (!records) {
      console.log(`⏭  Skipping ${step.label}: ${step.file} not found`);
      continue;
    }
    console.log(`\n⏳ Seeding ${step.label} (${records.length} records)...`);
    const { ok, fail } = await step.fn(records);
    console.log(`✅ ${step.label}: ${ok} inserted${fail ? `, ⚠ ${fail} failed` : ''}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
