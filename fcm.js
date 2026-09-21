// Firebase Cloud Messaging (HTTP v1 API) sender.
//
// Uses a service account JSON to mint an OAuth2 access token, then posts each
// article to FCM. One message per article, with a unique `apns`/`android`
// collapse key omitted and a data payload carrying the article URL.
//
// Set FCM_ENABLED=true and FCM_SERVICE_ACCOUNT_FILE=/secrets/firebase-service-account.json.
// If not configured, sends are skipped silently.

import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let cachedToken = null;
let cachedTokenExpiry = 0;
let cachedAccount = null;

function loadServiceAccount() {
  if (cachedAccount) return cachedAccount;
  const file = process.env.FCM_SERVICE_ACCOUNT_FILE || "";
  if (!file) return null;
  try {
    cachedAccount = JSON.parse(fs.readFileSync(file, "utf-8"));
    return cachedAccount;
  } catch (e) {
    console.error("[FCM] Failed to read service account:", e.message);
    return null;
  }
}

/** Target FCM device token(s) to send to. */
function getDeviceTokens() {
  const raw = process.env.FCM_DEVICE_TOKENS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isFcmEnabled() {
  return process.env.FCM_ENABLED === "true" && Boolean(process.env.FCM_SERVICE_ACCOUNT_FILE);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Mint (or reuse) an OAuth2 access token for the service account. */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry - 60) {
    return cachedToken;
  }

  const account = loadServiceAccount();
  if (!account) throw new Error("service account not configured");

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = base64url(signer.sign(account.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiry = now + (json.expires_in || 3600);
  return cachedToken;
}

/**
 * FCM rejects a message when the notification body exceeds 4KB. Japanese text
 * is 3 bytes per character, so trim to a byte budget rather than a char count.
 */
const FCM_NOTIFICATION_BODY_MAX_BYTES = 4096;
const FCM_NOTIFICATION_TITLE_MAX_BYTES = 1024;

/** Truncate [text] so its UTF-8 encoding fits within [maxBytes]. */
function truncateToBytes(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const ellipsis = "…";
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + ellipsis;
}

/**
 * Send one article notification to every configured device token.
 * @param {{ title: string, body?: string, url?: string }} article
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function sendFcmNotification({ title, body, url }) {
  if (!isFcmEnabled()) return { sent: 0, failed: 0 };

  const tokens = getDeviceTokens();
  if (tokens.length === 0) {
    console.warn("[FCM] No device tokens configured (FCM_DEVICE_TOKENS)");
    return { sent: 0, failed: 0 };
  }

  const account = loadServiceAccount();
  if (!account) return { sent: 0, failed: 0 };
  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    // Each message is independent; no `collapse_key`/group so Android treats
    // every article as its own notification. Trim both fields to FCM's limits
    // so a long article body cannot cause the whole message to be rejected.
    const safeTitle = truncateToBytes(title || "News Alert", FCM_NOTIFICATION_TITLE_MAX_BYTES);
    const safeBody = truncateToBytes(body || "", FCM_NOTIFICATION_BODY_MAX_BYTES);
    const message = {
      message: {
        token,
        notification: { title: safeTitle, body: safeBody },
        data: url ? { url } : {},
        android: {
          priority: "high",
          notification: {
            channel_id: "news_alerts",
            // Unique tag per message: prevents Android from replacing an
            // earlier notification with a newer one.
            tag: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
        },
      },
    };

    try {
      const accessToken = await getAccessToken();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      sent++;
    } catch (e) {
      failed++;
      console.error(`[FCM] Failed to send to ${token.slice(0, 12)}…: ${e.message}`);
    }
  }

  return { sent, failed };
}
