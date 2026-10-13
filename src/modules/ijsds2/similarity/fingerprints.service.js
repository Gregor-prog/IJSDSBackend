import prisma from "../../../config/prisma.js";
import { fingerprint, containment } from "./shingles.js";

const MIN_WORDS = 150; // too short to fingerprint meaningfully

/** Stores (or replaces) the fingerprints of a document. Only hashes are kept, never text. */
export const indexDocument = async ({ kind, articleId = null, manuscriptId = null, title = null, text }) => {
  if (!articleId && !manuscriptId) throw new Error("articleId or manuscriptId required");
  const { entries, wordCount } = fingerprint(text);
  if (wordCount < MIN_WORDS) return { indexed: false, reason: "too short" };
  const hashes = [...new Set(entries.map((e) => BigInt(e.h)))];
  const key = manuscriptId ? { manuscript_id: manuscriptId } : { article_id: articleId };
  await prisma.documentFingerprint.deleteMany({ where: key });
  await prisma.documentFingerprint.create({
    data: { kind, article_id: articleId, manuscript_id: manuscriptId, title, hashes, word_count: wordCount },
  });
  return { indexed: true, hashes: hashes.length };
};

/** Promotes a submission's fingerprints to the published archive once it is published. */
export const markPublished = (manuscriptId, articleId, title) =>
  prisma.documentFingerprint.updateMany({
    where: { manuscript_id: manuscriptId },
    data: { kind: "PUBLISHED", article_id: articleId, title },
  });

/**
 * Finds IJSDS documents that share fingerprints with `entries`, excluding the manuscript's
 * own earlier revisions. Returns per-document containment plus the union coverage.
 */
export const findLocalOverlaps = async (entries, { excludeManuscriptId }) => {
  if (!entries.length) return { score: 0, docs: [], matched: [] };
  const hashStrings = [...new Set(entries.map((e) => String(e.h)))];
  const rows = await prisma.$queryRaw`
    SELECT id, kind, title, article_id, hashes
    FROM document_fingerprints
    WHERE hashes && ${hashStrings}::bigint[]
      AND (manuscript_id IS NULL OR manuscript_id <> ${excludeManuscriptId}::uuid)
    LIMIT 60`;

  const covered = new Set();
  const docs = rows
    .map((r) => {
      const set = new Set(r.hashes.map(Number));
      for (const e of entries) if (set.has(e.h)) covered.add(e.h);
      return { kind: r.kind, title: r.title, articleId: r.article_id, containment: containment(entries, set) };
    })
    .filter((d) => d.containment > 0)
    .sort((a, b) => b.containment - a.containment);

  return { score: covered.size / entries.length, docs, matched: entries.filter((e) => covered.has(e.h)) };
};
