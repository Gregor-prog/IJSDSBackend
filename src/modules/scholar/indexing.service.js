import fs from "fs-extra";
import jwt from "jsonwebtoken";
import axios from "axios";

/**
 * Pings Google Indexing API using standard service account credentials (signed JWT)
 * @param {string} url - The URL that was published/updated.
 */
export const pingGoogleIndexingApi = async (url) => {
  let keyData = null;

  try {
    // 1. Load credentials from environment variable string (best for Docker/Cloud Run)
    if (process.env.GOOGLE_INDEXING_KEY) {
      keyData = JSON.parse(process.env.GOOGLE_INDEXING_KEY);
    } 
    // 2. Fall back to loading from file path
    else if (process.env.GOOGLE_INDEXING_KEY_FILE) {
      const keyFilePath = process.env.GOOGLE_INDEXING_KEY_FILE;
      if (await fs.pathExists(keyFilePath)) {
        keyData = await fs.readJson(keyFilePath);
      } else {
        console.error(`[indexing] Google service account key file not found at: ${keyFilePath}`);
        return;
      }
    } 
    // 3. No credentials provided
    else {
      console.warn("[indexing] Neither GOOGLE_INDEXING_KEY nor GOOGLE_INDEXING_KEY_FILE is configured. Skipping Google Indexing API ping.");
      return;
    }

    const clientEmail = keyData.client_email;
    const privateKey = keyData.private_key;

    if (!clientEmail || !privateKey) {
      console.error("[indexing] Invalid service account key structure: missing email or private key");
      return;
    }

    // 1. Construct JWT for Google OAuth2
    const tokenPayload = {
      iss: clientEmail,
      sub: clientEmail,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/indexing",
    };

    // 2. Sign the JWT with private key using RS256 algorithm
    const signedJwt = jwt.sign(tokenPayload, privateKey, {
      algorithm: "RS256",
      expiresIn: "1h",
    });

    // 3. Exchange JWT for access token
    const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    });

    const accessToken = tokenResponse.data.access_token;
    if (!accessToken) {
      throw new Error("Failed to retrieve access token from Google OAuth2");
    }

    // 4. Send indexing notification
    const response = await axios.post(
      "https://indexing.googleapis.com/v3/urlNotifications:publish",
      {
        url: url,
        type: "URL_UPDATED",
      },
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

/**
 * Pings IndexNow (Bing/Yandex)
 * @param {string} url - The URL that was published/updated.
 */
export const pingIndexNow = async (url) => {
  const indexNowKey = process.env.INDEXNOW_KEY;
  if (!indexNowKey) {
    return; // Skip silently if no key configured
  }

  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.host;

    // IndexNow API accepts request with key and keyLocation parameters
    const response = await axios.post("https://api.indexnow.org/IndexNow", {
      host: host,
      key: indexNowKey,
      keyLocation: `${url.split("/papers")[0]}/${indexNowKey}.txt`, // standard verification file path
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
  // Run pings in parallel without blocking execution
  await Promise.allSettled([
    pingGoogleIndexingApi(articleUrl),
    pingIndexNow(articleUrl),
  ]);
};
