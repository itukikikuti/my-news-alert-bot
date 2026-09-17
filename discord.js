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

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
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
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  // Discord returns 204 No Content on success.
  if (res.status !== 204 && !res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${text}`);
  }
  return { sent: true };
}
