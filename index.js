import Parser from "rss-parser";
import {
  DISCORD_WEBHOOK_URL,
  cleanText,
  extractOriginalUrl,
  loadState,
  saveState,
  sendToDiscord,
  recordNotification,
} from "./lib.js";

const parser = new Parser();

const RSS_URLS = process.env.RSS_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

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
      const latest = feed.items?.[0];
      if (!latest) continue;

      const entryId = latest.guid || latest.id || latest.link || latest.title;
      const title = cleanText(latest.title) || "(no title)";
      const link = extractOriginalUrl(latest.link);
      const summary = latest.contentSnippet || latest.summary || latest.content || "";
      const publishedAt = latest.published || latest.pubDate || latest.isoDate || latest.updated;

      const lastId = state[url];
      if (entryId && entryId !== lastId) {
        await sendToDiscord(title, link, { summary, publishedAt });
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
