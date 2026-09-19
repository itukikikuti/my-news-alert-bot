// Discord notification via Incoming Webhook.
// Set DISCORD_WEBHOOK_URL in the environment to enable.
// If unset, Discord notifications are skipped silently.

function getWebhookUrl() {
  return process.env.DISCORD_WEBHOOK_URL || "";
}

// Discord embed description limit is 4096 characters, but multibyte text
// (e.g. Japanese) hits the webhook's byte-based limit earlier: empirical
// testing shows ~3350 Japanese chars is the practical ceiling, so we cap at
// 3000 for headroom (title/URL/JSON escaping). The embed URL still links to
// the full article.
const DESCRIPTION_MAX = 3000;

// Discord merges notifications from the same webhook/user that arrive close
// together (grouping + collapsing) unless each message can be told apart.
// We (1) send one notification at a time, serially, with a small gap, and
// (2) give every message a unique nonce + distinct timestamp so Discord does
// not collapse them into a single "1 new message" bubble.
//
// Note: Android groups notifications per app/channel, so widening the gap does
// not reliably yield separate banners and can even suppress later ones. When a
// run produces several articles we therefore send ONE combined digest message
// (see sendDiscordDigest) instead of many rapid messages.
const SERIAL_DELAY_MS = 1200;

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendDiscordNotification({ title, body, url }) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return { skipped: true };
  }

  const embed = {
    title: truncate(title, 250),
    url: url || undefined,
    description: truncate(body, DESCRIPTION_MAX) || undefined,
    color: 0x5865f2, // Discord blurple
    // Per-message timestamp so consecutive notifications differ.
    timestamp: new Date().toISOString(),
    footer: { text: `ID: ${Math.random().toString(36).slice(2, 10)}` },
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [embed],
      // Prevent Discord from merging consecutive webhook messages.
      nonce: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    }),
  });

  // Discord returns 204 No Content on success.
  if (res.status !== 204 && !res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${text}`);
  }
  return { sent: true };
}

/**
 * Send several articles as ONE combined digest notification.
 * Android groups notifications per app/channel, so a single message per run
 * is the reliable way to make sure the user actually sees the articles.
 * @param {Array<{title:string, body?:string, url?:string}>} items
 * @returns {Promise<{sent:boolean, skipped?:boolean}>}
 */
export async function sendDiscordDigest(items) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return { skipped: true };
  }
  if (items.length === 0) {
    return { sent: false };
  }

  const header = `📰 新着 ${items.length} 件`;

  // Build the digest. Each article gets a numbered title line plus a body
  // excerpt. Stay within the embed description budget by allocating the
  // remaining space across articles.
  const perArticleBudget = Math.max(
    200,
    Math.floor((DESCRIPTION_MAX - items.length * 20) / items.length)
  );

  const parts = items.map((it, i) => {
    const n = i + 1;
    const titleLine = it.url ? `**${n}. [${it.title}](${it.url})**` : `**${n}. ${it.title}**`;
    const excerpt = truncate(it.body, perArticleBudget);
    return excerpt ? `${titleLine}\n${excerpt}` : titleLine;
  });

  const description = truncate(parts.join("\n\n"), DESCRIPTION_MAX);

  const embed = {
    title: truncate(header, 250),
    description,
    color: 0x5865f2, // Discord blurple
    timestamp: new Date().toISOString(),
    footer: { text: `ID: ${Math.random().toString(36).slice(2, 10)}` },
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [embed],
      nonce: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    }),
  });

  if (res.status !== 204 && !res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${text}`);
  }
  return { sent: true };
}

/**
 * Send several notifications without Discord collapsing them together.
 * Messages are sent serially with a small delay between them.
 * @param {Array<{title:string, body?:string, url?:string}>} items
 * @returns {Promise<{sent:number, failed:number}>}
 */
export async function sendDiscordNotifications(items) {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await sendDiscordNotification(items[i]);
      if (r.sent) sent++;
    } catch (e) {
      failed++;
      console.error("[DISCORD] Failed to send notification:", e);
    }
    if (i < items.length - 1) await sleep(SERIAL_DELAY_MS);
  }
  return { sent, failed };
}
