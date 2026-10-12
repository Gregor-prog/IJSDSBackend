import prisma from "../../config/prisma.js";
import { getReconciledFees } from "./payment.service.js";
import { settlePayment } from "../ijsds2/payments.service.js";
import { GATES } from "../ijsds2/ijsds2.constants.js";
import { createNotification } from "../notifications/notifications.service.js";
import {
  sendPaymentConfirmedEmail,
  sendPaymentReceivedEditorEmail,
} from "../email/email.service.js";

const PAYMENT_LABELS = {
  vetting: "Vetting Fee",
  processing: "Publication Fee",
};

const FEE_FIELD = {
  vetting: "vetting_fee",
  processing: "processing_fee",
};

const paystackController = async (req, res, next) => {
  try {
    const { reference, articleId, type } = req.body;

    if (!FEE_FIELD[type]) {
      return res.status(400).json({
        success: false,
        message: `Unknown payment type "${type}". Must be vetting or processing.`,
      });
    }

    // Legacy contract (articleId + vetting|processing) now settles through the IJSDS 2.0
    // gate service: server-verified amount/payer, idempotent, drives the state machine.
    const gate = type === "vetting" ? "GATE_1" : "GATE_2";
    const manuscript = await prisma.manuscript.findFirst({
      where: { submission: { article_id: articleId } },
      select: { id: true },
    });
    if (!manuscript) {
      return res.status(404).json({ success: false, message: "No manuscript found for this article" });
    }
    const settled = await settlePayment({ reference, gate, manuscriptId: manuscript.id, payerUserId: req.user.id });
    if (settled.needsReview) {
      return res.status(409).json({
        success: false,
        message: `Payment received but the manuscript is in state ${settled.state}; the editorial office will reconcile it.`,
      });
    }
    const paymentResult = {
      status: true,
      dataStatus: "success",
      amount: GATES[gate].amount_naira * 100,
      currency: "NGN",
      track: "local",
    };

    if (!settled.alreadyProcessed) {
      // Fetch article + submitter for notification context
      const article = await prisma.article.findUnique({
        where: { id: articleId },
        select: {
          id: true,
          title: true,
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
      const isGlobal = paymentResult.track === "global";
      const amountLabel = isGlobal
        ? `₦${(paymentResult.amount / 100).toLocaleString()} (Global Track)`
        : `₦${(paymentResult.amount / 100).toLocaleString()}`;

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

/**
 * GET /api/payment/history
 * Returns the fees the authenticated user has already paid on Paystack,
 * so the submission form can restore paid state + reference on load even if
 * the in-browser success callback never fired.
 */
export const reconcilePayments = async (req, res, next) => {
  try {
    const data = await getReconciledFees(req.user.email, req.user.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export default paystackController;
