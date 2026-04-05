import { Resend } from "resend";
import { templates } from "../email/email.templates.js";

const TECH_SUPPORT_EMAIL = "tech@ijsds.org";

const getResend = () => {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  return new Resend(process.env.RESEND_API_KEY);
};

/**
 * Submit a support ticket:
 *  1. Sends the ticket details to tech@ijsds.org
 *  2. Sends a confirmation email to the user
 */
export const submitSupportTicket = async ({ name, email, subject, category, message }) => {
  const ticketId = `IJSDS-${Date.now().toString(36).toUpperCase()}`;
  const resend = getResend();

  // 1. Send ticket to tech support
  const techEmail = templates.support_ticket({
    name,
    email,
    subject,
    category,
    message,
    ticketId,
  });

  const { error: techError } = await resend.emails.send({
    from: "IJSDS Support <noreply@ijsds.org>",
    replyTo: email,
    to: TECH_SUPPORT_EMAIL,
    subject: techEmail.subject,
    html: techEmail.html,
  });

  if (techError) {
    console.error("[support] Failed to send ticket to tech team:", techError);
    throw new Error("Failed to submit support ticket. Please try again later.");
  }

  console.log(`[support] Ticket ${ticketId} sent to ${TECH_SUPPORT_EMAIL}`);

  // 2. Send confirmation to the user (fire-and-forget)
  const confirmEmail = templates.support_ticket_confirmation({
    name,
    ticketId,
    ticketSubject: subject,
  });

  resend.emails.send({
    from: "IJSDS Support <noreply@ijsds.org>",
    to: email,
    subject: confirmEmail.subject,
    html: confirmEmail.html,
  }).catch((err) => {
    console.error(`[support] Failed to send confirmation to ${email}:`, err.message);
  });

  return { ticketId };
};
