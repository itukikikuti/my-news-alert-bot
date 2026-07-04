import fs from "fs/promises";
import path from "path";
import webpush from "web-push";

// ---------------------------------------------------------------------------
// VAPID configuration
// ---------------------------------------------------------------------------

export const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

let vapidConfigured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
} else {
  console.warn(
    "[PUSH] VAPID keys are not fully configured. " +
    "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT to enable Web Push. " +
    "Generate keys with: node -e \"import('web-push').then(wp => { const k = wp.default.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey); console.log('VAPID_PRIVATE_KEY=' + k.privateKey); })\""
  );
}

// ---------------------------------------------------------------------------
// Subscription persistence
// ---------------------------------------------------------------------------

/** Returns the current subscriptions file path, resolved at call time for testability. */
function getSubscriptionsFile() {
  if (process.env.SUBSCRIPTIONS_FILE) return process.env.SUBSCRIPTIONS_FILE;
  const stateFile = process.env.STATE_FILE || "/data/state.json";
  return path.join(path.dirname(stateFile), "subscriptions.json");
}

export async function loadSubscriptions() {
  const SUBSCRIPTIONS_FILE = getSubscriptionsFile();
  try {
    const raw = await fs.readFile(SUBSCRIPTIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[PUSH] Failed to load subscriptions:", e);
    }
    return [];
  }
}

async function saveSubscriptions(subscriptions) {
  const SUBSCRIPTIONS_FILE = getSubscriptionsFile();
  await fs.mkdir(path.dirname(SUBSCRIPTIONS_FILE), { recursive: true });
  await fs.writeFile(
    SUBSCRIPTIONS_FILE,
    JSON.stringify(subscriptions, null, 2),
    "utf-8"
  );
}

/** Validate that an object looks like a PushSubscription. */
export function isValidSubscription(sub) {
  return (
    sub !== null &&
    typeof sub === "object" &&
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    sub.keys !== null &&
    typeof sub.keys === "object" &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  );
}

/** Store or update a subscription (deduplicated by endpoint). */
export async function addSubscription(subscription) {
  const subscriptions = await loadSubscriptions();
  const idx = subscriptions.findIndex((s) => s.endpoint === subscription.endpoint);
  if (idx >= 0) {
    subscriptions[idx] = subscription;
  } else {
    subscriptions.push(subscription);
  }
  await saveSubscriptions(subscriptions);
}

/** Remove a subscription by endpoint. */
export async function removeSubscription(endpoint) {
  const subscriptions = await loadSubscriptions();
  const filtered = subscriptions.filter((s) => s.endpoint !== endpoint);
  await saveSubscriptions(filtered);
}

// ---------------------------------------------------------------------------
// Send push notifications
// ---------------------------------------------------------------------------

/**
 * Send a push notification to all stored subscriptions.
 * @param {{ title: string, body?: string, url?: string, icon?: string, badge?: string, tag?: string }} payload
 * @returns {{ sent: number, failed: number, removed: number }}
 */
export async function sendPushNotifications(payload) {
  if (!vapidConfigured) {
    console.warn("[PUSH] Skipping push: VAPID not configured.");
    return { sent: 0, failed: 0, removed: 0 };
  }

  const subscriptions = await loadSubscriptions();
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, removed: 0 };
  }

  const data = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  let removed = 0;
  const toRemove = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, data);
        sent++;
      } catch (err) {
        const status = err.statusCode;
        if (status === 404 || status === 410) {
          // Subscription is expired / invalid — schedule removal
          toRemove.push(sub.endpoint);
          removed++;
        } else {
          console.error(`[PUSH] Failed to send to ${sub.endpoint}: ${err.message}`);
          failed++;
        }
      }
    })
  );

  // Clean up expired subscriptions
  if (toRemove.length > 0) {
    const current = await loadSubscriptions();
    const cleaned = current.filter((s) => !toRemove.includes(s.endpoint));
    await saveSubscriptions(cleaned);
  }

  return { sent, failed, removed };
}
