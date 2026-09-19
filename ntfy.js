// ntfy notification client.
// Set NTFY_URL (server base URL) and NTFY_TOPIC to enable.
// If either is unset, ntfy notifications are skipped silently.
//
// Why ntfy over Discord webhooks: Android collapses successive notifications
// from the same app into one grouped banner. ntfy's Android app lets the user
// turn notification grouping off, and each publish can carry a stable message
// id, so individual articles are shown as separate notifications.
//
// HTTP publish API: POST {baseUrl}/{topic} with the message body.
// Headers: Title, Priority, Tags, Click, Markdown.

function getBaseUrl() {
  return (process.env.NTFY_URL || "").replace(/\/+$/, "");
}

function getTopic() {
  return process.env.NTFY_TOPIC || "";
}

export function isNtfyEnabled() {
  return Boolean(getBaseUrl() && getTopic());
}

/**
 * Publish one message to ntfy.
 * @param {{ title: string, body?: string, url?: string, tags?: string[] }} payload
 * @returns {Promise<{ sent?: boolean, skipped?: boolean }>}
 */
export async function sendNtfyNotification({ title, body, url, tags }) {
  const baseUrl = getBaseUrl();
  const topic = getTopic();
  if (!baseUrl || !topic) {
    return { skipped: true };
  }

  const headers = {
    Title: encodeURIComponent(title || "News Alert"),
    Markdown: "yes",
  };
  if (url) headers.Click = url;
  if (Array.isArray(tags) && tags.length) headers.Tags = tags.join(",");

  const res = await fetch(`${baseUrl}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers,
    body: body || "",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ntfy publish failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return { sent: true };
}
