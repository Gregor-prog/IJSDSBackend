// IJSDS 2.0 constants (PRD v2.4.0-PROD). Money is integer naira here and converted to
// kobo only at the Paystack boundary. These are fixed by the PRD; score thresholds are
// NOT here — they live in versioned configuration (see integrity.config.js).

export const FINANCIALS = Object.freeze({
  GATE_1_NAIRA: 5000,
  GATE_2_NAIRA: 25500,
  TOTAL_APC_NAIRA: 30500,
  REFERRAL_COMMISSION_NAIRA: 1000,
  // Two accounts: the Journal Manager gets a fixed share, Parakletus gets the rest.
  GATE_2_SPLIT: Object.freeze({
    journal_manager_naira: 9500,
    parakletus_naira: 16000,
  }),
});

/**
 * Gate 2 revenue split between the two accounts. For ₦25,500 this is exactly ₦9,500 to the
 * Journal Manager and ₦16,000 to Parakletus. Any other total (Global Card) uses the same
 * percentage for the Journal Manager (9,500 / 25,500), floored to the kobo, and Parakletus
 * takes the remainder, so the two parts always sum to exactly what was collected.
 */
export const computeGate2Split = (totalNaira) => {
  const { journal_manager_naira: jm, parakletus_naira: pk } = FINANCIALS.GATE_2_SPLIT;
  const totalKobo = Math.round(totalNaira * 100);
  const manager = Math.floor((totalKobo * jm) / (jm + pk));
  return { journal_manager_naira: manager / 100, parakletus_naira: (totalKobo - manager) / 100 };
};

export const GATES = Object.freeze({
  GATE_1: { payment_type: "EVALUATION_FEE", amount_naira: FINANCIALS.GATE_1_NAIRA },
  GATE_2: { payment_type: "APC", amount_naira: FINANCIALS.GATE_2_NAIRA },
});

// What Paystack may actually charge for a gate (kobo).
//  local : PRD net fee, plus an allowance for the processor-fee gross-up the checkout
//          adds (Paystack 1.5% + ₦100; ₦5,178 / ₦25,991 today). Under-payment and
//          over-payment are both rejected.
//  global: legacy "Global Card" price tier (₦15,800 / ₦43,184). NOT defined by the PRD —
//          accepted at exactly the legacy amounts so current behaviour is preserved, but
//          Gate 2 is split in the same proportions as the local split (computeGate2Split).
export const GLOBAL_TRACK_KOBO = Object.freeze({ GATE_1: 1_580_000, GATE_2: 4_318_418 });

export const acceptableKobo = (gate, track) => {
  if (track === "global") {
    const exact = GLOBAL_TRACK_KOBO[gate];
    return { min: exact, max: exact };
  }
  const net = GATES[gate].amount_naira;
  return { min: net * 100, max: Math.ceil(net * 1.02 + 100) * 100 };
};

export const AUDIT_DELAY_HOURS = 24;
export const MAX_REVIEWER_LOAD = 3;

// Journal calendar: batch publishes on the 28th, 00:00 WAT (UTC+1, no DST).
export const WAT_OFFSET_HOURS = 1;
export const BATCH_DAY = 28;
export const BATCH_CUTOFF_DAY = 27; // 23:59 WAT
export const VOLUME_BASE_YEAR = 2024; // volume = year - 2024 (Vol 2 = 2026)

// Allowed manuscript state transitions (PRD §2/§3). Anything else is rejected.
export const TRANSITIONS = Object.freeze({
  DRAFT_PENDING_FEE1: ["SUBMITTED"],
  SUBMITTED: ["IN_AUDIT"],
  IN_AUDIT: ["AUDIT_REJECTED", "AUDIT_REVISION_REQUESTED", "AUDIT_PASSED_PENDING_APC"],
  AUDIT_REVISION_REQUESTED: ["IN_AUDIT"], // free revision upload re-runs Stage 2
  AUDIT_REJECTED: [], // terminal: resubmit as a new manuscript + new Gate 1
  AUDIT_PASSED_PENDING_APC: ["APC_PAID"],
  APC_PAID: ["REVIEWER_MATCHED"],
  REVIEWER_MATCHED: ["IN_PEER_REVIEW"],
  IN_PEER_REVIEW: ["AUTHOR_REVISION_REQUESTED", "ACCEPTED"],
  AUTHOR_REVISION_REQUESTED: ["IN_PEER_REVIEW"],
  ACCEPTED: ["IN_PRODUCTION"],
  IN_PRODUCTION: ["READY_FOR_RELEASE"],
  READY_FOR_RELEASE: ["PUBLISHED"],
  PUBLISHED: [],
});

export const IN_PROGRESS_STATES = Object.freeze([
  "IN_AUDIT",
  "AUDIT_REVISION_REQUESTED",
  "AUDIT_PASSED_PENDING_APC",
  "APC_PAID",
  "REVIEWER_MATCHED",
  "IN_PEER_REVIEW",
  "AUTHOR_REVISION_REQUESTED",
  "ACCEPTED",
  "IN_PRODUCTION",
]);

export const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};
