import fs from "fs";
import crypto from "crypto";
import axios from "axios";

const HEADERS = [
  "Author Email",
  "Author Name",
  "Co-Author Email",
  "Co-Author Name",
  "Paper Title",
  "Submission Date",
  "Submission ID",
  "Status",
];

/**
 * Normalizes author items into clean { name, email } objects.
 */
export const normalizeAuthorList = (rawAuthors, fallbackEmail = "", fallbackName = "") => {
  if (!rawAuthors) {
    return [{ name: fallbackName || "Unknown", email: fallbackEmail || "" }];
  }

  let list = rawAuthors;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [list];
    }
  }

  if (!Array.isArray(list)) list = [list];

  const parsed = list
    .map((item) => {
      if (typeof item === "string") {
        // Match "Name (email@example.com)" or "Name <email@example.com>"
        const emailMatch = item.match(/[<(\[]?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[>)\]]?/);
        const email = emailMatch ? emailMatch[1].trim() : "";
        const name = item.replace(emailMatch ? emailMatch[0] : "", "").trim() || item.trim();
        return { name, email };
      }
      if (typeof item === "object" && item !== null) {
        const firstName = item.firstName || item.first_name || item.given || "";
        const lastName = item.lastName || item.last_name || item.family || item.surname || "";
        const name = item.name || (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName) || "";
        const email = item.email || item.author_email || "";
        return { name: name.trim(), email: email.trim() };
      }
      return null;
    })
    .filter(Boolean);

  if (parsed.length === 0) {
    return [{ name: fallbackName || "Unknown", email: fallbackEmail || "" }];
  }

  return parsed;
};

/**
 * Builds rows for Google Sheets in the user-specified format:
 * [Author Email, Author Name, Co-Author Email, Co-Author Name, Paper Title, Submission Date, Submission ID, Status]
 */
export const buildSubmissionRows = (submission, article, rawAuthors = null) => {
  const submitterEmail = submission?.submitter?.email || "";
  const submitterName = submission?.submitter?.full_name || "";
  const correspondingEmail = article?.corresponding_author_email || submitterEmail;

  const authors = normalizeAuthorList(
    rawAuthors ?? article?.authors,
    correspondingEmail,
    submitterName
  );

  const primaryAuthor = authors[0] || { name: submitterName || "Unknown", email: correspondingEmail };
  const coAuthors = authors.slice(1);

  const title = article?.title || "Untitled Paper";
  const date = submission?.submitted_at
    ? new Date(submission.submitted_at).toLocaleDateString("en-GB")
    : new Date().toLocaleDateString("en-GB");
  const submissionId = submission?.id || "";
  const status = submission?.status || "submitted";

  // If there are co-authors, create a row for each co-author
  if (coAuthors.length > 0) {
    return coAuthors.map((co) => [
      primaryAuthor.email || correspondingEmail || "N/A",
      primaryAuthor.name || submitterName || "N/A",
      co.email || "N/A",
      co.name || "N/A",
      title,
      date,
      submissionId,
      status,
    ]);
  }

  // If single author (no co-authors)
  return [
    [
      primaryAuthor.email || correspondingEmail || "N/A",
      primaryAuthor.name || submitterName || "N/A",
      "N/A",
      "N/A",
      title,
      date,
      submissionId,
      status,
    ],
  ];
};

/**
 * Acquires a Google OAuth2 access token using the service account credentials.
 */
const getGoogleSheetsAccessToken = async () => {
  let keyData = null;

  if (process.env.GOOGLE_INDEXING_KEY) {
    keyData = JSON.parse(process.env.GOOGLE_INDEXING_KEY);
  } else {
    const keyFilePath = process.env.GOOGLE_INDEXING_KEY_FILE || "new-project-499802-a9987f9001b1.json";
    if (fs.existsSync(keyFilePath)) {
      keyData = JSON.parse(fs.readFileSync(keyFilePath, "utf8"));
    } else {
      throw new Error(`Google service account key file not found: ${keyFilePath}`);
    }
  }

  const { client_email: clientEmail, private_key: privateKey } = keyData;
  if (!clientEmail || !privateKey) {
    throw new Error("Invalid service account key: missing client_email or private_key");
  }

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claimSet = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  ).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${claimSet}`);
  const signature = sign.sign(privateKey, "base64url");
  const assertion = `${header}.${claimSet}.${signature}`;

  const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  return tokenRes.data.access_token;
};

/**
 * Appends rows directly to Google Sheets via Google Sheets API v4.
 */
export const appendViaSheetsApi = async (rows) => {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID environment variable is not defined");
  }

  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";
  const accessToken = await getGoogleSheetsAccessToken();

  // 1. Check if the sheet already has headers
  try {
    const getRes = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName)}!A1:H1`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const existingValues = getRes.data?.values;
    if (!existingValues || existingValues.length === 0 || existingValues[0].length === 0) {
      // Sheet is empty, write headers first
      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=USER_ENTERED`,
        { values: [HEADERS] },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    }
  } catch (headerErr) {
    console.warn("[google-sheets] Header verification warning:", headerErr.response?.data?.error?.message || headerErr.message);
  }

  // 2. Append the submission rows
  const appendRes = await axios.post(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName)}!A:H:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { values: rows },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  return appendRes.data;
};

/**
 * Appends rows via Google Apps Script Webhook URL.
 */
export const appendViaWebhook = async (rows, metadata = {}) => {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("GOOGLE_SHEETS_WEBHOOK_URL environment variable is not defined");
  }

  const payload = {
    action: "appendRows",
    headers: HEADERS,
    rows,
    entries: rows.map((r) => ({
      authorEmail: r[0],
      authorName: r[1],
      coAuthorEmail: r[2],
      coAuthorName: r[3],
      paperTitle: r[4],
      submissionDate: r[5],
      submissionId: r[6],
      status: r[7],
    })),
    metadata,
  };

  const response = await axios.post(webhookUrl, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
  });

  return response.data;
};

/**
 * Main dispatcher: automatically called whenever any user submits a paper.
 * Supports both Google Sheets API (via service account) and Apps Script Webhook.
 */
export const syncSubmissionToGoogleSheets = async ({ submission, article, authors }) => {
  const hasSpreadsheetId = !!process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const hasWebhookUrl = !!process.env.GOOGLE_SHEETS_WEBHOOK_URL;

  if (!hasSpreadsheetId && !hasWebhookUrl) {
    console.log(
      "[google-sheets] Note: Neither GOOGLE_SHEETS_SPREADSHEET_ID nor GOOGLE_SHEETS_WEBHOOK_URL is set in .env. Skipping Google Sheets update."
    );
    return { success: false, message: "No Google Sheets configuration provided in .env" };
  }

  const rows = buildSubmissionRows(submission, article, authors);

  const results = {
    sheetsApi: null,
    webhook: null,
    rowsAdded: rows.length,
  };

  // 1. If Sheets API configured, append via Sheets API
  if (hasSpreadsheetId) {
    try {
      results.sheetsApi = await appendViaSheetsApi(rows);
      console.log(`[google-sheets] Appended ${rows.length} row(s) to Google Sheets via API for submission ${submission?.id}`);
    } catch (err) {
      console.error("[google-sheets] Sheets API Error:", err.response?.data?.error?.message || err.message);
      results.sheetsApiError = err.message;
    }
  }

  // 2. If Webhook URL configured, post to Webhook
  if (hasWebhookUrl) {
    try {
      results.webhook = await appendViaWebhook(rows, {
        submissionId: submission?.id,
        title: article?.title,
      });
      console.log(`[google-sheets] Dispatched ${rows.length} row(s) to Google Sheets Webhook for submission ${submission?.id}`);
    } catch (err) {
      console.error("[google-sheets] Webhook Error:", err.message);
      results.webhookError = err.message;
    }
  }

  return { success: true, ...results };
};
