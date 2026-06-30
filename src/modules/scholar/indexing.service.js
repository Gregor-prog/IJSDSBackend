import fs from "fs-extra";
import jwt from "jsonwebtoken";
import axios from "axios";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://www.ijsds.org";

/**
 * Pings the Google Indexing API to request immediate crawling of a URL.
 * Requires the service account to be added as Owner in Google Search Console.
 */
export const pingGoogleIndexingApi = async (url) => {
  let keyData = null;

  try {
    if (process.env.GOOGLE_INDEXING_KEY) {
      keyData = JSON.parse(process.env.GOOGLE_INDEXING_KEY);
    } else if (process.env.GOOGLE_INDEXING_KEY_FILE) {
      const keyFilePath = process.env.GOOGLE_INDEXING_KEY_FILE;
      if (await fs.pathExists(keyFilePath)) {
        keyData = await fs.readJson(keyFilePath);
      } else {
        console.error(`[indexing] Key file not found at: ${keyFilePath}`);
        return;
      }
    } else {
      console.warn("[indexing] No Google Indexing credentials configured. Skipping.");
      return;
    }

    const { client_email: clientEmail, private_key: privateKey } = keyData;
    if (!clientEmail || !privateKey) {
      console.error("[indexing] Invalid service account key: missing email or private key");
      return;
    }

    const signedJwt = jwt.sign(
      {
        iss: clientEmail,
        sub: clientEmail,
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/indexing",
      },
      privateKey,
      { algorithm: "RS256", expiresIn: "1h" }
    );

    const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    });

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) throw new Error("No access token returned from Google OAuth2");

    const response = await axios.post(
      "https://indexing.googleapis.com/v3/urlNotifications:publish",
      { url, type: "URL_UPDATED" },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`[indexing] Google Indexing API ping success for URL: ${url}. Response status: ${response.status}`);
  } catch (err) {
    console.error(`[indexing] Google Indexing API ping failed for URL: ${url}`, err.message);
  }
};

export const pingIndexNow = async (url) => {
  const indexNowKey = process.env.INDEXNOW_KEY;
  if (!indexNowKey) {
    return;
  }

  try {
    const parsedUrl = new URL(FRONTEND_URL);
    const host = parsedUrl.host;

    const response = await axios.post("https://api.indexnow.org/IndexNow", {
      host: host,
      key: indexNowKey,
      // Key verification file must live on the same host as the canonical URLs
      keyLocation: `${FRONTEND_URL}/${indexNowKey}.txt`,
      urlList: [url],
    });

    console.log(`[indexing] IndexNow ping success for URL: ${url}. Status: ${response.status}`);
  } catch (err) {
    console.error(`[indexing] IndexNow ping failed for URL: ${url}`, err.message);
  }
};

/**
 * Main wrapper to notify all search engines on publish
 * @param {string} articleUrl - Canonical URL of the article
 */
export const notifySearchEngines = async (articleUrl) => {
  console.log(`[indexing] Notifying search engines for newly published article: ${articleUrl}`);
  await Promise.allSettled([
    pingGoogleIndexingApi(articleUrl),
    pingIndexNow(articleUrl),
  ]);
};
