import prisma from "../../config/prisma.js";
import verifyPayment from "./payment.service.js";
import { createNotification } from "../notifications/notifications.service.js";
import {
  sendPaymentConfirmedEmail,
  sendPaymentReceivedEditorEmail,
} from "../email/email.service.js";

const PAYMENT_LABELS = {
  vetting: "Vetting Fee",
  processing: "Processing Fee",
};

const paystackController = async (req, res, next) => {
  try {
    const { reference, amount, articleId, type } = req.body;

    const paymentResult = await verifyPayment(reference, amount);

    if (paymentResult.status === true) {
      const field = type === "vetting" ? "vetting_fee" : "processing_fee";

      await prisma.article.update({
        where: { id: articleId },
        data: { [field]: true },
      });

      // Fetch article + submitter for notification context
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        include: {
          submissions: {
            take: 1,
            orderBy: { submitted_at: "desc" },
            include: {
              submitter: { select: { id: true, full_name: true, email: true } },
            },
          },
        },
      });

      const submitter = article?.submissions?.[0]?.submitter;
      const paymentLabel = PAYMENT_LABELS[type] ?? type;
      const amountLabel = `₦${(amount / 100).toLocaleString()}`;

      // ── Author email + in-app notification ───────────────────────────────
      if (submitter?.email) {
        await sendPaymentConfirmedEmail({
          to: submitter.email,
          recipientId: submitter.id,
          name: submitter.full_name ?? "Author",
          paymentType: paymentLabel,
          amount: amountLabel,
          articleTitle: article.title,
        });

        await createNotification({
          user_id: submitter.id,
          title: "Payment Confirmed",
          message: `Your ${paymentLabel} of ${amountLabel} for "${article.title}" has been received.`,
          type: "success",
        });
      }

      // ── Editor notification ───────────────────────────────────────────────
      const editors = await prisma.profile.findMany({
        where: { role: "editor" },
        select: { id: true, full_name: true, email: true },
      });

      for (const editor of editors) {
        await sendPaymentReceivedEditorEmail({
          to: editor.email,
          editorName: editor.full_name ?? "Editor",
          articleTitle: article.title,
          userName: submitter?.full_name ?? "Author",
          paymentType: paymentLabel,
          amount: amountLabel,
        });

        await createNotification({
          user_id: editor.id,
          title: "Payment Received",
          message: `${paymentLabel} received for "${article.title}" by ${submitter?.full_name ?? "an author"}.`,
          type: "info",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Payment confirmed",
      data: paymentResult,
    });
  } catch (err) {
    next(err);
  }
};

export default paystackController;
