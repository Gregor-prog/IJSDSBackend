const PLATFORM_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

// Shared layout wrapper
const layout = (headerColor, headerTitle, body) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:${headerColor};padding:32px 40px;">
            <h1 style="margin:0;color:#fff;font-size:22px;">${headerTitle}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;color:#374151;font-size:15px;line-height:1.7;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 32px;color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;">
            International Journal for Social Work and Development Studies &nbsp;|&nbsp;
            <a href="mailto:editor@ijsds.org" style="color:#6366f1;">editor@ijsds.org</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const btn = (url, label, color = "#6366f1") =>
  `<p style="margin:24px 0 0;"><a href="${url}" style="background:${color};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">${label}</a></p>`;

const table = (rows) =>
  `<table style="width:100%;border-collapse:collapse;margin:16px 0;">
    ${rows
      .map(
        ([k, v]) => `
      <tr>
        <td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;font-weight:600;width:40%;">${k}</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb;">${v}</td>
      </tr>`,
      )
      .join("")}
  </table>`;

// ── Templates ─────────────────────────────────────────────────────────────────

export const templates = {
  user_welcome: ({ name }) => ({
    subject:
      "Welcome to International Journal of Social Work and Development Studies",
    html: layout(
      "#4f46e5",
      "Welcome to IJSDS",
      `
      <p>Hi ${name},</p>
      <p>We're glad you've joined the <strong>International Journal for Social Work and Development Studies</strong>.</p>
      <h3 style="color:#4f46e5;">What's Next?</h3>
      <ul>
        <li>Complete your profile with your affiliation and ORCID ID</li>
        <li>Browse submission guidelines</li>
        <li>Submit your first manuscript</li>
      </ul>
      ${btn(`${PLATFORM_URL}/profile`, "Complete Your Profile")}
    `,
    ),
  }),

  author_welcome: ({ name }) => ({
    subject: "Welcome to IJSDS — Author Onboarding",
    html: layout(
      "#16a34a",
      "Author Onboarding",
      `
      <p>Hi ${name},</p>
      <p>Welcome! Before you submit, please make sure your manuscript meets our requirements:</p>
      <ul>
        <li>Correct manuscript format (.docx or .pdf)</li>
        <li>Abstract: 150–250 words</li>
        <li>5–8 keywords</li>
        <li>APA 7th edition references</li>
        <li>All co-authors have approved the submission</li>
      </ul>
      <h3 style="color:#16a34a;">Review Timeline</h3>
      <ul>
        <li>Initial screening: 2–3 weeks</li>
        <li>Peer review: 4–6 weeks</li>
        <li>Final decision: 6–8 weeks</li>
      </ul>
      ${btn(`${PLATFORM_URL}/guidelines`, "View Guidelines", "#16a34a")}
      ${btn(`${PLATFORM_URL}/submit`, "Start Submission", "#4f46e5")}
    `,
    ),
  }),

  submission_received: ({ name, submissionId, title, submissionDate }) => ({
    subject: `Submission Received — ${title}`,
    html: layout(
      "#7c3aed",
      "Submission Received",
      `
      <p>Hi ${name},</p>
      <p>We have successfully received your manuscript. Our editorial team will review it shortly.</p>
      ${table([
        ["Submission ID", submissionId],
        ["Title", title],
        ["Date", submissionDate],
        ["Status", "Under Editorial Review"],
      ])}
      <h3 style="color:#7c3aed;">What Happens Next?</h3>
      <ol>
        <li>Initial desk review (scope &amp; format check)</li>
        <li>Peer reviewer assignment</li>
        <li>Peer review (4–6 weeks)</li>
        <li>Editorial decision notification</li>
      </ol>
      ${btn(`${PLATFORM_URL}/dashboard`, "Track Your Submission")}
    `,
    ),
  }),

  fee_information: ({ name, title }) => ({
    subject: `Publication Fees Information — ${title}`,
    html: layout(
      "#dc2626",
      "Publication Fees",
      `
      <p>Hi ${name},</p>
      <p>To proceed with the review of <strong>${title}</strong>, the following fees apply:</p>
      ${table([
        ["Vetting Fee", "₦5,000 — due on submission"],
        ["Processing Fee", "₦20,000 — due after acceptance"],
      ])}
      <p>Fees can be paid via the journal dashboard using Paystack.</p>
      ${btn(`${PLATFORM_URL}/dashboard`, "Go to Dashboard", "#dc2626")}
    `,
    ),
  }),

  review_assigned: ({ reviewerName, title, submissionId, deadline }) => ({
    subject: `Review Assignment — ${title}`,
    html: layout(
      "#0891b2",
      "Review Assignment",
      `
      <p>Hi ${reviewerName},</p>
      <p>You have been invited to review the following manuscript:</p>
      ${table([
        ["Title", title],
        ["Submission ID", submissionId],
        ["Review Deadline", deadline],
      ])}
      <p>Please accept or decline the invitation from your reviewer dashboard.</p>
      ${btn(`${PLATFORM_URL}/reviewer/dashboard`, "Go to Reviewer Dashboard", "#0891b2")}
    `,
    ),
  }),

  decision_made: ({ name, title, decision, decisionRationale }) => ({
    subject: `Editorial Decision — ${title}`,
    html: layout(
      "#374151",
      "Editorial Decision",
      `
      <p>Hi ${name},</p>
      <p>The editorial team has reached a decision on your manuscript <strong>${title}</strong>:</p>
      <p style="font-size:18px;font-weight:700;color:#111827;">${decision}</p>
      ${decisionRationale ? `<h3>Editor's Comments</h3><p>${decisionRationale}</p>` : ""}
      ${btn(`${PLATFORM_URL}/dashboard`, "View Details")}
    `,
    ),
  }),

  submission_accepted: ({ name, title }) => ({
    subject: `Submission Accepted for Review — ${title}`,
    html: layout(
      "#16a34a",
      "Submission Accepted",
      `
      <p>Hi ${name},</p>
      <p>Congratulations! Your manuscript <strong>${title}</strong> has been accepted for peer review.</p>
      <h3 style="color:#16a34a;">Next Steps</h3>
      <ol>
        <li>Reviewers will be assigned within the next few days</li>
        <li>Peer review typically takes 4–6 weeks</li>
        <li>You will receive progress updates by email</li>
      </ol>
      ${btn(`${PLATFORM_URL}/dashboard`, "Track Progress", "#16a34a")}
    `,
    ),
  }),

  article_published: ({
    name,
    title,
    doi,
    volume,
    issue,
    publicationDate,
  }) => ({
    subject: `Article Published — ${title}`,
    html: layout(
      "#4f46e5",
      "Article Published!",
      `
      <p>Hi ${name},</p>
      <p>Your article <strong>${title}</strong> has been officially published.</p>
      ${table([
        [
          "DOI",
          doi ? `<a href="https://doi.org/${doi}">${doi}</a>` : "Pending",
        ],
        ["Volume", volume ?? "—"],
        ["Issue", issue ?? "—"],
        ["Publication Date", publicationDate],
      ])}
      <p>Share your work with colleagues and cite it using the DOI above.</p>
      ${btn(`${PLATFORM_URL}/articles`, "View Published Article")}
    `,
    ),
  }),

  article_published_celebratory: ({
    name,
    title,
    doi,
    volume,
    issue,
    publicationDate,
  }) => ({
    subject: `Congratulations! Your Research is Now Published — ${title}`,
    html: layout(
      "#4f46e5",
      "Publication Success!",
      `
      <p>Hi ${name},</p>
      <p>It is our great pleasure to inform you that your article, <strong>"${title}"</strong>, has been officially published in the <strong>International Journal for Social Work and Development Studies</strong>.</p>
      
      <p>This is a significant professional milestone, and we are proud to have your research as part of our latest release. Your contribution helps advance the discourse in social work and global development.</p>

      <h3 style="color:#4f46e5;">Official Publication Details</h3>
      ${table([
        ["Title", title],
        [
          "DOI",
          doi
            ? `<a href="https://doi.org/${doi}" style="color:#6366f1; text-decoration:none;">${doi}</a>`
            : "Processing...",
        ],
        [
          "Citation",
          `IJSDS Vol. ${volume ?? "—"}, Issue ${issue ?? "—"} (${new Date(publicationDate).getFullYear()})`,
        ],
        ["Published Date", publicationDate],
      ])}

      <h3 style="color:#4f46e5;">Boost Your Article's Visibility</h3>
      <p>To increase the reach and impact of your work, we recommend the following:</p>
      <ul style="padding-left:20px;">
        <li><strong>Share on Socials:</strong> Post the DOI link on LinkedIn, Twitter (X), and ResearchGate.</li>
        <li><strong>Update Your Profile:</strong> Add the publication to your ORCID, Google Scholar, and institutional CV.</li>
        <li><strong>Email Signature:</strong> Mention your latest publication in your professional email signature.</li>
      </ul>

      ${btn(`${PLATFORM_URL}/articles`, "View Your Published Article", "#4f46e5")}

      <p style="margin-top:24px; font-style: italic;">Thank you for choosing IJSDS. We look forward to seeing more of your work in the future!</p>
      <p>Best regards,<br/><strong>The Editorial Team</strong></p>
    `,
    ),
  }),

  payment_confirmed: ({ name, paymentType, amount, articleTitle }) => ({
    subject: `${paymentType} Payment Confirmed — ${articleTitle}`,
    html: layout(
      "#16a34a",
      "Payment Confirmed",
      `
      <p>Hi ${name},</p>
      <p>Your payment has been received and confirmed.</p>
      ${table([
        ["Payment Type", paymentType],
        ["Amount", amount],
        ["Article", articleTitle],
        [
          "Status",
          '<span style="color:#16a34a;font-weight:700;">Confirmed ✓</span>',
        ],
      ])}
      ${btn(`${PLATFORM_URL}/dashboard`, "Go to Dashboard", "#16a34a")}
    `,
    ),
  }),

  payment_received_editor: ({
    editorName,
    articleTitle,
    userName,
    paymentType,
    amount,
  }) => ({
    subject: `Payment Received — ${paymentType} for ${articleTitle}`,
    html: layout(
      "#374151",
      "Payment Notification",
      `
      <p>Hi ${editorName},</p>
      <p>A payment has been received for the following submission:</p>
      ${table([
        ["Article", articleTitle],
        ["Author", userName],
        ["Payment Type", paymentType],
        ["Amount", amount],
      ])}
      ${btn(`${PLATFORM_URL}/editor/dashboard`, "View in Dashboard")}
    `,
    ),
  }),

  payment_pending_editor: ({
    editorName,
    articleTitle,
    userName,
    userEmail,
    paymentType,
  }) => ({
    subject: `Payment Pending — ${paymentType} for ${articleTitle}`,
    html: layout(
      "#f59e0b",
      "Payment Pending",
      `
      <p>Hi ${editorName},</p>
      <p>A payment is pending for the following submission:</p>
      ${table([
        ["Article", articleTitle],
        ["Author", userName],
        ["Author Email", userEmail],
        ["Payment Type", paymentType],
      ])}
      ${btn(`${PLATFORM_URL}/editor/dashboard`, "View in Dashboard", "#f59e0b")}
    `,
    ),
  }),

  password_reset: ({ name, resetUrl }) => ({
    subject: "Reset your IJSDS password",
    html: layout(
      "#dc2626",
      "Password Reset Request",
      `
      <p>Hi ${name},</p>
      <p>We received a request to reset the password for your IJSDS account. Click the button below to set a new password.</p>
      <p><strong>This link expires in 1 hour.</strong></p>
      ${btn(resetUrl, "Reset Password", "#dc2626")}
      <p style="margin-top:24px;font-size:13px;color:#6b7280;">If the button doesn't work, copy this link:<br/>${resetUrl}</p>
      <p style="margin-top:16px;font-size:13px;color:#6b7280;">If you did not request a password reset, you can safely ignore this email — your password will not change.</p>
    `,
    ),
  }),

  send_receipt: ({ name, type, receiptLink }) => ({
    subject: `Receipt for ${type}`,
    html: layout(
      "#4f46e5",
      "Payment Receipt",
      `
      <p>Hi ${name},</p>
      <p>Thank you for your payment. Please find your receipt for <strong>${type}</strong> below.</p>
      ${btn(receiptLink, "Download Receipt")}
      <p style="margin-top:16px;font-size:13px;color:#6b7280;">If the button doesn't work, copy this link: ${receiptLink}</p>
    `,
    ),
  }),

  support_ticket: ({ name, email, subject: ticketSubject, category, message, ticketId }) => ({
    subject: `[Support Ticket #${ticketId}] ${ticketSubject}`,
    html: layout(
      "#dc2626",
      "New Support Ticket",
      `
      <p>A new support ticket has been submitted.</p>
      ${table([
        ["Ticket ID", ticketId],
        ["From", `${name} &lt;${email}&gt;`],
        ["Category", category ?? "General"],
        ["Subject", ticketSubject],
      ])}
      <h3 style="color:#dc2626;">Message</h3>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;white-space:pre-wrap;">${message}</div>
      <p style="margin-top:16px;font-size:13px;color:#6b7280;">Reply directly to this email to respond to the user at ${email}.</p>
    `,
    ),
  }),

  support_ticket_confirmation: ({ name, ticketId, ticketSubject }) => ({
    subject: `We've received your request — Ticket #${ticketId}`,
    html: layout(
      "#4f46e5",
      "Support Request Received",
      `
      <p>Hi ${name},</p>
      <p>Thank you for reaching out. We've received your support request and a member of our technical team will get back to you shortly.</p>
      ${table([
        ["Ticket ID", ticketId],
        ["Subject", ticketSubject],
      ])}
      <p>If you need to follow up, please reply to this email or reference your ticket ID above.</p>
      <p style="margin-top:16px;">Best regards,<br/><strong>IJSDS Technical Support</strong></p>
    `,
    ),
  }),
};
