import prisma from "../../config/prisma.js";

// Thresholds are configuration with change history (PRD §7), never constants in the
// evaluator. DEFAULT_CONFIG seeds revision #1; editors tune it via PUT /config/integrity
// after editorial calibration. Every audit stores the revision id it ran under.
export const DEFAULT_CONFIG = Object.freeze({
  plagiarism: { moderate: 0.1, high: 0.18, critical: 0.25 },
  ai: { medium: 0.25, high: 0.5 },
  citations: {
    max_unresolved_ratio: 0.25,
    max_uncited_references: 3,
    min_relevance: 0.35,
  },
  structure: { min_word_count: 300 },
  // Auto-reject is only ever allowed for structural failure. Plagiarism at/above
  // `critical` is routed to editorial confirmation (PRD: "confirmed by policy/editorial
  // review"). AI risk can never reject (hard rule in the evaluator, not configurable).
  auto_reject_structural: true,
  related_list_size: 5,
  expose_raw_ai_score: false,
});

let cache = null;
const CACHE_MS = 30_000;

export const getActiveConfig = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let row = await prisma.integrityConfigRevision.findFirst({ orderBy: { created_at: "desc" } });
  if (!row) {
    row = await prisma.integrityConfigRevision.create({
      data: { config: DEFAULT_CONFIG, reason: "Initial defaults (uncalibrated)" },
    });
  }
  cache = { at: Date.now(), value: { id: row.id, ...mergeDefaults(row.config) } };
  return cache.value;
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const mergeDefaults = (cfg, base = DEFAULT_CONFIG) => {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = isObj(v) ? mergeDefaults(isObj(cfg?.[k]) ? cfg[k] : {}, v) : (cfg?.[k] ?? v);
  }
  return out;
};

export const updateConfig = async (patch, { userId, reason }) => {
  const current = await getActiveConfig();
  const { id: _id, ...currentCfg } = current;
  const next = mergeDefaults(patch, currentCfg);
  validateConfig(next);
  const row = await prisma.integrityConfigRevision.create({
    data: { config: next, changed_by: userId, reason: reason ?? null },
  });
  cache = null;
  return { id: row.id, ...next };
};

export const listConfigHistory = () =>
  prisma.integrityConfigRevision.findMany({ orderBy: { created_at: "desc" }, take: 50 });

const validateConfig = (c) => {
  const asc = (a, b, c2) => a <= b && b <= c2;
  const unit = (n) => typeof n === "number" && n >= 0 && n <= 1;
  const { moderate, high, critical } = c.plagiarism;
  if (![moderate, high, critical].every(unit) || !asc(moderate, high, critical)) {
    const e = new Error("plagiarism thresholds must be in [0,1] and ascending");
    e.status = 400;
    throw e;
  }
  if (![c.ai.medium, c.ai.high].every(unit) || c.ai.medium > c.ai.high) {
    const e = new Error("ai thresholds must be in [0,1] and ascending");
    e.status = 400;
    throw e;
  }
  if (!Number.isInteger(c.related_list_size) || c.related_list_size < 0 || c.related_list_size > 25) {
    const e = new Error("related_list_size must be an integer 0-25");
    e.status = 400;
    throw e;
  }
};
