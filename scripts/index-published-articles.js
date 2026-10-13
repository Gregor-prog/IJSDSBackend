// One-off / re-runnable backfill: fingerprints every published article's manuscript file so
// the built-in similarity check can compare new submissions against IJSDS's archive.
//   node scripts/index-published-articles.js          (skips already-indexed articles)
//   node scripts/index-published-articles.js --force  (re-index everything)
import "dotenv/config";
import prisma from "../src/config/prisma.js";
import { fetchFileBuffer, extractText, parseManuscriptText } from "../src/modules/ijsds2/manuscriptParser.js";
import { indexDocument } from "../src/modules/ijsds2/similarity/fingerprints.service.js";

const force = process.argv.includes("--force");
const articles = await prisma.article.findMany({
  where: { status: "published", manuscript_file_url: { not: null } },
  select: { id: true, title: true, manuscript_file_url: true },
});
const done = new Set((await prisma.documentFingerprint.findMany({ where: { article_id: { not: null } }, select: { article_id: true } })).map((r) => r.article_id));

let ok = 0, skipped = 0, failed = 0;
for (const a of articles) {
  if (!force && done.has(a.id)) { skipped++; continue; }
  try {
    const text = await extractText(await fetchFileBuffer(a.manuscript_file_url), a.manuscript_file_url);
    const r = await indexDocument({ kind: "PUBLISHED", articleId: a.id, title: a.title, text: parseManuscriptText(text).body_text });
    r.indexed ? ok++ : (skipped++, console.log(`skip ${a.id}: ${r.reason}`));
  } catch (e) {
    failed++;
    console.warn(`fail ${a.id} (${a.title.slice(0, 50)}): ${e.message}`);
  }
}
console.log(`done: ${ok} indexed, ${skipped} skipped, ${failed} failed of ${articles.length}`);
await prisma.$disconnect();
process.exit(0);
