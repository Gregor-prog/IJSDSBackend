const verifyPayment = async (reference, amount) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY_LIVE;

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

  const { status, message, data } = await response.json();

  if (!status || data.status !== "success")
    throw new Error("Payment not verified, please try again later");

  if (data.amount !== amount)
    throw new Error(
      "Amount paid does not match the required amount. Please contact support for a refund"
    );

  return { status, dataStatus: data.status, amount };
};

export default verifyPayment;
