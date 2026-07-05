import Parser from "rss-parser";
import {
  cleanText,
  extractOriginalUrl,
  deriveEntryKey,
  loadState,
  saveState,
  loadRSSUrls,
  recordNotification,
} from "./lib.js";
import { sendPushNotifications } from "./push.js";

const parser = new Parser();

// Maximum number of seen entry keys kept per feed to prevent unbounded state growth.
const MAX_SEEN_KEYS = 500;

async function checkAndNotify() {
  const RSS_URLS = await loadRSSUrls();
  if (RSS_URLS.length === 0) {
    throw new Error("No RSS URLs configured. Add URLs via the admin UI or set RSS_URLS env var as fallback.");
  }

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

      // Process items oldest-first so notifications arrive in chronological order.
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
