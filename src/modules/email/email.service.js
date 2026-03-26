import { Resend } from "resend";
import prisma from "../../config/prisma.js";
import { templates } from "./email.templates.js";

const getResend = () => {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  return new Resend(process.env.RESEND_API_KEY);
};

/**
 * Send a templated email and log it to the email_notifications table.
 *
 * @param {string} templateName  - Key from email.templates.js
 * @param {object} data          - Template variables + required { to, recipientId? }
 *
 * Usage:
 *   await sendEmail("submission_received", {
 *     to: "author@example.com",
 *     recipientId: "uuid",       // optional — profile id
 *     submissionId: "uuid",      // optional — related submission
 *     name: "Dr. Smith",
 *     title: "My Paper",
 *     submissionDate: "2026-03-24",
 *   });
 */
const sendEmail = async (templateName, data) => {
  const builder = templates[templateName];
  if (!builder) {
    throw new Error(`Unknown email template: "${templateName}"`);
  }

  const { to, recipientId, submissionId, ...templateData } = data;

  if (!to) throw new Error("Recipient email (to) is required");

  const { subject, html } = builder(templateData);

  let status = "sent";

  try {
    await getResend().emails.send({
      from: "IJSDS <noreply@ijsds.org>",
      to,
      subject,
      html,
    });
  } catch (err) {
    status = "failed";
    console.error(`[email] Failed to send "${templateName}" to ${to}:`, err.message);
  }

  // Always log — even on failure, so we can audit and retry
  await prisma.emailNotification.create({
    data: {
      recipient_email: to,
      recipient_id: recipientId ?? null,
      subject,
      body: html,
      notification_type: templateName,
      related_submission_id: submissionId ?? null,
      status,
    },
  });

  if (status === "failed") {
    throw new Error(`Email delivery failed for template "${templateName}"`);
  }
};

export default sendEmail;

// Named re-exports for common cases so callers don't have to remember template keys
export const sendWelcomeEmail = ({ name, to, recipientId }) =>
  sendEmail("user_welcome", { to, recipientId, name });

export const sendAuthorWelcomeEmail = ({ name, to, recipientId }) =>
  sendEmail("author_welcome", { to, recipientId, name });

export const sendSubmissionReceivedEmail = (data) =>
  sendEmail("submission_received", data);

export const sendFeeInformationEmail = (data) =>
  sendEmail("fee_information", data);

export const sendReviewAssignedEmail = (data) =>
  sendEmail("review_assigned", data);

export const sendDecisionEmail = (data) =>
  sendEmail("decision_made", data);

export const sendSubmissionAcceptedEmail = (data) =>
  sendEmail("submission_accepted", data);

export const sendArticlePublishedEmail = (data) =>
  sendEmail("article_published", data);

export const sendPaymentConfirmedEmail = (data) =>
  sendEmail("payment_confirmed", data);

export const sendPaymentReceivedEditorEmail = (data) =>
  sendEmail("payment_received_editor", data);

export const sendPaymentPendingEditorEmail = (data) =>
  sendEmail("payment_pending_editor", data);

export const sendReceiptEmail = (data) =>
  sendEmail("send_receipt", data);
