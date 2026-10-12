// Provider registry. Kept separate from index.js/heuristic.js so adapters can register
// themselves at import time without a circular-import TDZ error.

export class ProviderNotConfiguredError extends Error {
  constructor(kind) {
    super(`No ${kind} provider configured (set ${kind === "plagiarism" ? "PLAGIARISM_PROVIDER" : "AI_DETECTION_PROVIDER"})`);
    this.name = "ProviderNotConfiguredError";
  }
}

export const plagiarismProviders = new Map();
export const aiProviders = new Map();

export const registerPlagiarismProvider = (name, factory) => plagiarismProviders.set(name, factory);
export const registerAiProvider = (name, factory) => aiProviders.set(name, factory);
