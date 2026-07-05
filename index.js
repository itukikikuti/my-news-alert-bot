import Parser from "rss-parser";
import {
  cleanText,
  extractOriginalUrl,
  loadState,
  saveState,
  loadRSSUrls,
  recordNotification,
} from "./lib.js";
import { sendPushNotifications } from "./push.js";

const parser = new Parser();

async function checkAndNotify() {
  const RSS_URLS = await loadRSSUrls();
  if (RSS_URLS.length === 0) {
    throw new Error("No RSS URLs configured. Add URLs via the admin UI or set RSS_URLS env var as fallback.");
  }

  const state = await loadState();

  for (const url of RSS_URLS) {
    try {
      const feed = await parser.parseURL(url);
      const latest = feed.items?.[0];
      if (!latest) continue;

      const entryId = latest.guid || latest.id || latest.link || latest.title;
      const title = cleanText(latest.title) || "(no title)";
      const link = extractOriginalUrl(latest.link);
      const summary = latest.contentSnippet || latest.summary || latest.content || "";

      const lastId = state[url];
      if (entryId && entryId !== lastId) {
        await sendPushNotifications({ title, body: summary ? cleanText(summary).slice(0, 120) : undefined, url: link }).catch((e) => {
          console.error("[PUSH] Failed to send push notifications:", e);
        });
        await recordNotification({
          title,
          link,
          feedUrl: url,
          sentAt: new Date().toISOString(),
        });
        state[url] = entryId;
        console.log(`[NOTIFIED] ${title}`);
      } else {
        console.log(`[SKIP] no new entry for ${url}`);
      }
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
