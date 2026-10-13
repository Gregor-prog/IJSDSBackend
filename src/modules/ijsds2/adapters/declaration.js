import { registerAiProvider } from "./registry.js";

// "Author declaration" AI provider (AI_DETECTION_PROVIDER=declaration).
//
// Editorial decision: no automated AI-authorship detector is used. Public detectors
// misclassify non-native English writing as AI-generated at high rates, and most IJSDS
// authors write in a second language. Instead Stage 2 requires an explicit AI-use disclosure
// statement in the manuscript (checked in audit.service structuralChecks, enforced in policy.js).
//
// This adapter makes no network call and reports NO score: score is null and the band is
// NOT_RUN, so nothing downstream can mistake "not measured" for "low risk".
registerAiProvider("declaration", () => ({
  async score() {
    return {
      provider: "author-declaration",
      modelVersion: "declaration-1",
      requestId: null,
      score: null,
      flaggedSegments: [],
      skipped: true,
    };
  },
}));
