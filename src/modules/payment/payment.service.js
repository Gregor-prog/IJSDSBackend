const FEE_MATRIX = {
  NGN: {
    vetting: 1025400, // ₦10,000 net → grossed up
    processing: 2599100, // ₦25,500 net → grossed up
  },
  USD: {
    vetting: 1041, // $10.41 in cents
    processing: 2601, // $26.01 in cents
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

  if (!FEE_MATRIX[paidCurrency]) {
    throw new Error(`Unsupported transaction currency: ${paidCurrency}`);
  }

  const expectedAmount = FEE_MATRIX[paidCurrency][type];
  if (!expectedAmount) {
    throw new Error(`Invalid fee type: ${type}`);
  }

  if (paidAmount < expectedAmount) {
    throw new Error(
      `Underpayment detected. Expected ${expectedAmount}, received ${paidAmount} ${paidCurrency}`
    );
  }

  return { status, dataStatus: data.status, amount: paidAmount, currency: paidCurrency };
};

export default verifyPayment;
