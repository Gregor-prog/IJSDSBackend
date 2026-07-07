const FEE_MATRIX = {
  vetting: {
    local: 1025400, // ₦10,254
    global: 1580000, // ₦15,800
  },
  processing: {
    local: 2599100, // ₦25,991
    global: 4318418, // ₦43,184 — must match PUBLICATION_FEE_GLOBAL charged by the client
  },
};

const PAYSTACK_BASE = "https://api.paystack.co";

const authHeaders = () => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY_LIVE;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY_LIVE is not configured");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secretKey}`,
  };
};

// The frontend tags the publication fee as "publication" in Paystack metadata,
// while the backend uses "processing" internally. Normalize both.
const normalizeFeeType = (raw) => {
  if (raw === "vetting") return "vetting";
  if (raw === "publication" || raw === "processing") return "processing";
  return null;
};

const readCustomField = (tx, variableName) =>
  tx.metadata?.custom_fields?.find((f) => f.variable_name === variableName)
    ?.value;

const verifyPayment = async (reference, type) => {
  const response = await fetch(
    `${PAYSTACK_BASE}/transaction/verify/${reference}`,
    {
      method: "GET",
      headers: authHeaders(),
    },
  );

  const { status, data } = await response.json();

  if (!status || data.status !== "success")
    throw new Error("Payment not verified, please try again later");

  const paidCurrency = data.currency;
  const paidAmount = data.amount;

  if (!FEE_MATRIX[type]) {
    throw new Error(`Invalid fee type: ${type}`);
  }

  const track =
    data.metadata?.custom_fields?.find(
      (f) => f.variable_name === "billing_track",
    )?.value || "local";

  const expectedAmount = FEE_MATRIX[type][track];
  if (!expectedAmount) {
    throw new Error(`Invalid billing track: ${track}`);
  }

  if (paidAmount < expectedAmount) {
    throw new Error(
      `Underpayment detected for ${track} track. Expected ${expectedAmount}, received ${paidAmount} ${paidCurrency}`,
    );
  }

  return {
    status,
    dataStatus: data.status,
    amount: paidAmount,
    currency: paidCurrency,
    track,
  };
};

/**
 * Reconcile fees already paid on Paystack for a given user, keyed by their
 * account email. Used to recover payments whose in-browser success callback
 * never fired (popup closed early, network blip, ad blocker) so the submission
 * form can restore the paid state and the reference on load.
 *
 * Returns a map like:
 *   { vetting: { paid, reference, amount, currency, track },
 *     processing: { ... } }
 * Only fee types actually paid appear as keys.
 */
export const getReconciledFees = async (email, userId) => {
  if (!email) return {};
  const headers = authHeaders();

  // 1. Resolve the Paystack customer for this email
  const custRes = await fetch(
    `${PAYSTACK_BASE}/customer/${encodeURIComponent(email)}`,
    { headers },
  );
  if (custRes.status === 404) return {};
  const custJson = await custRes.json();
  if (!custJson.status || !custJson.data?.id) return {};
  const customerId = custJson.data.id;

  // 2. List this customer's successful transactions
  const txRes = await fetch(
    `${PAYSTACK_BASE}/transaction?customer=${customerId}&status=success&perPage=100`,
    { headers },
  );
  const txJson = await txRes.json();
  if (!txJson.status || !Array.isArray(txJson.data)) return {};

  // 3. Keep the most recent valid payment per fee type
  const sorted = [...txJson.data].sort(
    (a, b) =>
      new Date(b.paid_at || b.createdAt || 0) -
      new Date(a.paid_at || a.createdAt || 0),
  );

  const result = {};
  for (const tx of sorted) {
    if (tx.status !== "success") continue;

    const type = normalizeFeeType(readCustomField(tx, "fee_type"));
    if (!type || result[type]) continue; // already captured a newer one

    // Defense-in-depth: only reconcile the caller's own payments
    const submitterId = readCustomField(tx, "submitter_id");
    if (submitterId && submitterId !== userId) continue;

    const track = readCustomField(tx, "billing_track") || "local";
    const expected = FEE_MATRIX[type]?.[track];
    // Allow a small tolerance for gross-up rounding between the client's
    // displayed amount and the fee matrix.
    if (expected && tx.amount < Math.floor(expected * 0.98)) continue;

    result[type] = {
      paid: true,
      reference: tx.reference,
      amount: tx.amount,
      currency: tx.currency,
      track,
    };
  }

  return result;
};

export default verifyPayment;
