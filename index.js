import Parser from "rss-parser";
import {
  DISCORD_WEBHOOK_URL,
  cleanText,
  extractOriginalUrl,
  deriveEntryKey,
  loadState,
  saveState,
  sendToDiscord,
  recordNotification,
} from "./lib.js";
import { sendPushNotifications } from "./push.js";

const parser = new Parser();

const RSS_URLS = process.env.RSS_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

// Maximum number of seen entry keys kept per feed to prevent unbounded state growth.
const MAX_SEEN_KEYS = 500;

if (!DISCORD_WEBHOOK_URL) {
  throw new Error("DISCORD_WEBHOOK_URL is not set");
}
if (RSS_URLS.length === 0) {
  throw new Error("RSS_URLS is not set");
}

async function checkAndNotify() {
  const state = await loadState();

  for (const url of RSS_URLS) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items ?? [];
      if (items.length === 0) {
        console.log(`[SKIP] no entries for ${url}`);
        continue;
      }

      // Migrate old string state (single lastId) to array format.
      const rawState = state[url];
      const seenKeys = new Set(
        Array.isArray(rawState)
          ? rawState
          : typeof rawState === "string"
          ? [rawState]
          : []
      );

      // Process items oldest-first so Discord receives them in chronological order.
      const orderedItems = [...items].reverse();
      let notifiedCount = 0;

      for (const item of orderedItems) {
        const entryKey = deriveEntryKey(item);
        if (seenKeys.has(entryKey)) {
          continue;
        }
        seenKeys.add(entryKey);

        const title = cleanText(item.title) || "(no title)";
        const link = extractOriginalUrl(item.link);
        const summary = item.contentSnippet || item.summary || item.content || "";
        const publishedAt = item.isoDate || item.pubDate || item.published || item.updated || null;

        await sendToDiscord(title, link, { summary, publishedAt });
        await sendPushNotifications({
          title,
          body: summary ? cleanText(summary).slice(0, 120) : undefined,
          url: link,
        }).catch((e) => {
          console.error("[PUSH] Failed to send push notifications:", e);
        });
        await recordNotification({
          title,
          link,
          feedUrl: url,
          entryKey,
          publishedAt,
          sentAt: new Date().toISOString(),
        });
        notifiedCount++;
        console.log(`[NOTIFIED] ${title}`);
      }

      if (notifiedCount === 0) {
        console.log(`[SKIP] no new entries for ${url}`);
      }

      // Persist seen keys, keeping only the newest MAX_SEEN_KEYS entries.
      const allKeys = Array.from(seenKeys);
      state[url] = allKeys.slice(-MAX_SEEN_KEYS);
    } catch (e) {
      console.error(`[ERROR] ${url}`, e);
    }
  }

  await saveState(state);
}

checkAndNotify().catch((err) => {
  console.error(err);
  process.exit(1);
});
