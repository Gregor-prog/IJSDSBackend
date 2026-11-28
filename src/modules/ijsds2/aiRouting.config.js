import prisma from "../../config/prisma.js";
import { httpError } from "./ijsds2.constants.js";

export const VALID_PROVIDERS = Object.freeze(["openai", "anthropic", "google", "deterministic"]);

/**
 * Default OpenAI Paid Commercial API routing baseline (PRD v2.4.2-PROD).
 * Mirrors src/lib/ijsds2/aiRoutingDefaults.ts on the frontend.
 *
 * Uses a single direct commercial paid API key (`OPENAI_API_KEY`):
 *  - `text-embedding-3-small` (1536 dims) for pgvector citation & reviewer similarity
 *  - `gpt-5-mini` for fast structured extraction, classification, and layout planning
 *  - `gpt-5` for intricate scholarly reasoning, final copyedit diffs, and Vision QA
 * No consumer/free tiers; no training on unpublished manuscripts.
 */
export const DEFAULT_AI_ROUTING = Object.freeze({
  perManuscriptCapUsd: 0.75,
  shadowModeStages: ["stage4"],
  requireCommercialPaidTier: true,
  routes: {
    stage2a_screening: {
      provider: "openai",
      model: "gpt-5-mini",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.05,
    },
    stage2e_embeddings: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallbackProvider: null,
      fallbackModel: null,
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.01,
    },
    stage2f_synthesis: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5-mini",
      promptVersion: "v1.0.0",
      useBatchApi: true,
      enabled: true,
      maxCostUsd: 0.15,
    },
    stage3a_profile: {
      provider: "openai",
      model: "gpt-5-mini",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.03,
    },
    stage4a_analysis: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: null,
      fallbackModel: null,
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: false, // Gated on Editorial Board AI-policy update
      maxCostUsd: 0.15,
    },
    stage4c_synthesis: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: null,
      fallbackModel: null,
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: false,
      maxCostUsd: 0.12,
    },
    stage4e_revision_verify: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: null,
      fallbackModel: null,
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: false,
      maxCostUsd: 0.12,
    },
    stage6a_copyedit: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5-mini",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.2,
    },
    stage6b_template_select: {
      provider: "openai",
      model: "gpt-5-mini",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.02,
    },
    stage6c_layout_plan: {
      provider: "openai",
      model: "gpt-5-mini",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.05,
    },
    stage6e_visual_qa: {
      provider: "openai",
      model: "gpt-5",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5-mini",
      promptVersion: "v1.0.0",
      useBatchApi: false,
      enabled: true,
      maxCostUsd: 0.15,
    },
  },
});

let cache = null;
const CACHE_MS = 30_000;

export const resetAiRoutingCache = () => {
  cache = null;
};

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export const mergeAiRoutingDefaults = (incoming, base = DEFAULT_AI_ROUTING) => {
  const src = isObj(incoming) ? incoming : {};
  const routes = {};
  for (const [task, defaultRoute] of Object.entries(base.routes)) {
    const patch = isObj(src.routes?.[task]) ? src.routes[task] : {};
    routes[task] = { ...defaultRoute, ...patch };
  }
  return {
    perManuscriptCapUsd:
      typeof src.perManuscriptCapUsd === "number" ? src.perManuscriptCapUsd : base.perManuscriptCapUsd,
    shadowModeStages: Array.isArray(src.shadowModeStages) ? src.shadowModeStages : base.shadowModeStages,
    requireCommercialPaidTier:
      typeof src.requireCommercialPaidTier === "boolean"
        ? src.requireCommercialPaidTier
        : base.requireCommercialPaidTier,
    routes,
  };
};

export const validateAiRouting = (cfg) => {
  if (typeof cfg.perManuscriptCapUsd !== "number" || cfg.perManuscriptCapUsd <= 0 || cfg.perManuscriptCapUsd > 10) {
    throw httpError(400, "perManuscriptCapUsd must be a number in (0, 10]");
  }
  if (typeof cfg.requireCommercialPaidTier !== "boolean") {
    throw httpError(400, "requireCommercialPaidTier must be a boolean");
  }
  for (const [task, r] of Object.entries(cfg.routes)) {
    if (!VALID_PROVIDERS.includes(r.provider)) {
      throw httpError(400, `Invalid provider "${r.provider}" for task ${task}`);
    }
    if (r.fallbackProvider && !VALID_PROVIDERS.includes(r.fallbackProvider)) {
      throw httpError(400, `Invalid fallbackProvider "${r.fallbackProvider}" for task ${task}`);
    }
    if (!r.model || typeof r.model !== "string" || !r.model.trim()) {
      throw httpError(400, `Model ID is required for task ${task}`);
    }
    if (typeof r.maxCostUsd !== "number" || r.maxCostUsd < 0 || r.maxCostUsd > 5) {
      throw httpError(400, `maxCostUsd for task ${task} must be in [0, 5]`);
    }
  }
};

export const getActiveAiRouting = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let row = await prisma.aiRoutingConfigRevision.findFirst({ orderBy: { created_at: "desc" } });
  if (!row) {
    row = await prisma.aiRoutingConfigRevision.create({
      data: { config: DEFAULT_AI_ROUTING, reason: "Initial direct-API multi-provider defaults (v2.4.2-PROD)" },
    });
  }
  cache = { at: Date.now(), value: { id: row.id, ...mergeAiRoutingDefaults(row.config) } };
  return cache.value;
};

export const updateAiRouting = async (patch, { userId, reason }) => {
  if (!reason || String(reason).trim().length < 5) {
    throw httpError(400, "A change reason (at least 5 characters) is required");
  }
  const current = await getActiveAiRouting();
  const { id: _id, ...currentCfg } = current;
  const next = mergeAiRoutingDefaults(patch, currentCfg);
  validateAiRouting(next);
  const row = await prisma.aiRoutingConfigRevision.create({
    data: { config: next, changed_by: userId ?? null, reason: String(reason).trim() },
  });
  cache = null;
  return { id: row.id, ...next };
};

export const listAiRoutingHistory = () =>
  prisma.aiRoutingConfigRevision.findMany({
    orderBy: { created_at: "desc" },
    take: 50,
    select: { id: true, created_at: true, changed_by: true, reason: true },
  });
