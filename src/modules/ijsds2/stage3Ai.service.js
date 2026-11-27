import { invokeStructuredTask } from "./aiGateway.service.js";
import { MAX_REVIEWER_LOAD } from "./ijsds2.constants.js";

/**
 * Stage 3A anonymized expertise profile extraction (gpt-5-mini) and
 * Stage 3D explainable weighted candidate reranking (PRD v2.4.2-PROD §5).
 *
 * Weights (PRD §5.3D):
 *   35% Topic fit | 30% Methodological fit | 15% Context/language | 10% Availability | 10% Load
 * Zero referral, payment, or prestige features may enter the score.
 */

export const STAGE3_WEIGHTS = Object.freeze({
  topic: 0.35,
  methodologicalFit: 0.3,
  contextLanguage: 0.15,
  availability: 0.1,
  load: 0.1,
});

export const STAGE3A_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["discipline", "subdisciplines", "methods", "geographicContext", "topicKeywords"],
  properties: {
    discipline: { type: "string" },
    subdisciplines: { type: "array", items: { type: "string" } },
    methods: { type: "array", items: { type: "string" } },
    geographicContext: { type: "array", items: { type: "string" } },
    topicKeywords: { type: "array", items: { type: "string" } },
  },
};

export const extractManuscriptProfile = async ({ manuscriptId, title, abstract }, deps = {}) => {
  try {
    const res = await invokeStructuredTask(
      {
        manuscriptId,
        stage: "stage3",
        task: "stage3a_profile",
        systemPrompt:
          "Extract a structured anonymized reviewer-matching expertise profile from this manuscript title and abstract. Ignore author identity; output concise academic terms only.",
        userPrompt: `Title: ${title ?? ""}\n\nAbstract:\n${abstract ?? ""}`,
        jsonSchema: STAGE3A_PROFILE_SCHEMA,
        idempotencyKey: `stage3a:${manuscriptId}`,
      },
      deps,
    );
    if (res.skipped) return null;
    return res.output;
  } catch (err) {
    console.warn("[ijsds2] Stage 3A profile extraction skipped:", err.message);
    return null;
  }
};

const tokenOverlap = (targetTerms, haystackText) => {
  const clean = (targetTerms ?? []).map((t) => String(t).toLowerCase().trim()).filter((t) => t.length > 2);
  if (clean.length === 0) return 0.5; // Neutral when profile doesn't specify terms
  const lower = String(haystackText ?? "").toLowerCase();
  const hits = clean.filter((t) => lower.includes(t)).length;
  return Number(Math.min(1, hits / Math.min(clean.length, 4)).toFixed(4));
};

/**
 * Pure deterministic Stage 3D explainable component scorer.
 * Works both with a Stage 3A GPT-5-mini profile AND without one (keyword/vector baseline).
 */
export const scoreReviewerCandidate = ({
  baseSimilarity,
  activeLoad = 0,
  isAvailable = true,
  expertiseKeywords = [],
  bio = "",
  affiliation = "",
  manuscriptProfile = null,
}) => {
  const reviewerCorpus = `${(expertiseKeywords ?? []).join(" ")} ${bio ?? ""} ${affiliation ?? ""}`;
  const topic = Number(Math.min(1, Math.max(0, baseSimilarity ?? 0)).toFixed(4));

  const methodologicalFit = manuscriptProfile
    ? tokenOverlap(manuscriptProfile.methods, reviewerCorpus)
    : Number(Math.min(1, topic * 0.9 + 0.1).toFixed(4));

  const contextLanguage = manuscriptProfile
    ? tokenOverlap(manuscriptProfile.geographicContext, reviewerCorpus)
    : Number(Math.min(1, topic * 0.8 + 0.2).toFixed(4));

  const availability = isAvailable ? 1 : 0;
  const load = Number(Math.max(0, 1 - Math.min(activeLoad, MAX_REVIEWER_LOAD) / MAX_REVIEWER_LOAD).toFixed(4));

  const composite = Number(
    (
      topic * STAGE3_WEIGHTS.topic +
      methodologicalFit * STAGE3_WEIGHTS.methodologicalFit +
      contextLanguage * STAGE3_WEIGHTS.contextLanguage +
      availability * STAGE3_WEIGHTS.availability +
      load * STAGE3_WEIGHTS.load
    ).toFixed(4),
  );

  const reasons = [];
  if (topic >= 0.65) reasons.push("strong topic alignment");
  else if (topic >= 0.35) reasons.push("relevant topical overlap");
  if (manuscriptProfile && methodologicalFit >= 0.5) reasons.push("matching research methods");
  if (manuscriptProfile && contextLanguage >= 0.5) reasons.push("regional/contextual familiarity");
  if (activeLoad === 0) reasons.push("full review capacity available");
  else reasons.push(`${activeLoad}/${MAX_REVIEWER_LOAD} active load`);

  return {
    compositeSimilarity: composite,
    componentScores: {
      topic,
      methodologicalFit,
      contextLanguage,
      availability,
      load,
    },
    conflictStatus: "CLEAR",
    matchingRationale: reasons.length
      ? `COPE conflict-cleared candidate with ${reasons.join(", ")}.`
      : "COPE conflict-cleared eligible candidate.",
  };
};
