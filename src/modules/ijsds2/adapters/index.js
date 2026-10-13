import {
  ProviderNotConfiguredError,
  plagiarismProviders,
  aiProviders,
  registerPlagiarismProvider,
  registerAiProvider,
} from "./registry.js";
import "./heuristic.js";
import "./http.js";
import "./open.js";

// Provider-agnostic adapters (PRD §7 governance). Workflow/state logic only ever sees
// these interfaces:
//   plagiarism.check({ fullText, title }) -> { provider, requestId?, score(0-1), matches[] }
//   ai.score({ fullText, title })         -> { provider, modelVersion, requestId?, score(0-1), flaggedSegments[] }
// A vendor is wired in with registerPlagiarismProvider/registerAiProvider and selected by
// PLAGIARISM_PROVIDER / AI_DETECTION_PROVIDER. Vendor selection is an open PRD decision.
//
// FAIL CLOSED: if nothing is configured the adapter throws ProviderNotConfiguredError and
// the audit is routed to MANUAL_REVIEW. The built-in heuristic adapters are development
// stand-ins and are only used when INTEGRITY_ALLOW_HEURISTIC=true.

const allowHeuristic = () => process.env.INTEGRITY_ALLOW_HEURISTIC === "true";

export const getPlagiarismAdapter = () => {
  const name = process.env.PLAGIARISM_PROVIDER || (allowHeuristic() ? "heuristic-dev" : null);
  const factory = name && plagiarismProviders.get(name);
  if (!factory) throw new ProviderNotConfiguredError("plagiarism");
  return factory();
};

export const getAiAdapter = () => {
  const name = process.env.AI_DETECTION_PROVIDER || (allowHeuristic() ? "heuristic-dev" : null);
  const factory = name && aiProviders.get(name);
  if (!factory) throw new ProviderNotConfiguredError("ai");
  return factory();
};

export { ProviderNotConfiguredError, registerPlagiarismProvider, registerAiProvider };
