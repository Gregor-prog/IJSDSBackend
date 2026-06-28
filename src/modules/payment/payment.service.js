const FEE_MATRIX = {
  vetting: {
    local: 1025400, // ₦10,254
    global: 1580000, // ₦15,800
  },
  processing: {
    local: 2599100, // ₦25,991
    global: 3660000, // ₦36,600
  },
};

const verifyPayment = async (reference, type) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY_LIVE;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY_LIVE is not configured");

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secretKey}`,
      },
    }
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
      (f) => f.variable_name === "billing_track"
    )?.value || "local";

  const expectedAmount = FEE_MATRIX[type][track];
  if (!expectedAmount) {
    throw new Error(`Invalid billing track: ${track}`);
  }

  if (paidAmount < expectedAmount) {
    throw new Error(
      `Underpayment detected for ${track} track. Expected ${expectedAmount}, received ${paidAmount} ${paidCurrency}`
    );
  }

  return { status, dataStatus: data.status, amount: paidAmount, currency: paidCurrency, track };
};

export default verifyPayment;
