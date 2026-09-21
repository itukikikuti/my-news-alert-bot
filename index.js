import Parser from "rss-parser";
import {
  cleanText,
  extractOriginalUrl,
  deriveEntryKey,
  loadState,
  saveState,
  loadRSSFeeds,
  loadHistory,
  recordNotification,
} from "./lib.js";
import { sendNtfyNotification, isNtfyEnabled } from "./ntfy.js";
import { sendFcmNotification, isFcmEnabled } from "./fcm.js";
import { fetchArticleText } from "./article.js";
import { shouldNotify } from "./ai-filter.js";

const parser = new Parser();

// Maximum number of seen entry keys kept per feed to prevent unbounded state growth.
const MAX_SEEN_KEYS = 500;

async function checkAndNotify() {
  const FEEDS = await loadRSSFeeds();
  if (FEEDS.length === 0) {
    throw new Error("No RSS URLs configured. Add URLs via the admin UI or set RSS_URLS env var as fallback.");
  }

  const state = await loadState();
  // Recent notifications, used by the AI filter for duplicate detection.
  const history = await loadHistory();

  for (const feedConfig of FEEDS) {
    const url = feedConfig.url;
    const feedPrompt = feedConfig.prompt;
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
      // Collect the articles to notify first, then send them serially.
      const orderedItems = [...items].reverse();
      const toNotify = [];

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

        // Prefer the full article body; fall back to title+link only when the
        // page cannot be fetched or no article text is extracted.
        const articleText = link ? await fetchArticleText(link) : null;
        if (!articleText) {
          console.warn(`[ARTICLE] Falling back to title+link for ${link || title}`);
        }

        // Ask the LLM whether this article should be notified at all.
        // Fail-open: a disabled or failing filter still notifies.
        const decision = await shouldNotify({
          title,
          body: articleText || undefined,
          feedPrompt,
          history,
        });
        if (!decision.notify) {
          console.log(`[AI-SKIP] ${title} — ${decision.reason || ""}`);
          continue;
        }

        toNotify.push({ title, body: articleText || undefined, url: link, entryKey, publishedAt });
      }

      // Send notifications. FCM and ntfy each get one message per article so
      // the Android app shows every article as its own notification.
      if (isFcmEnabled()) {
        for (const a of toNotify) {
          await sendFcmNotification({
            title: a.title,
            body: a.body,
            url: a.url,
          }).catch((e) => {
            console.error("[FCM] Failed to send notification:", e);
          });
        }
      }

      if (isNtfyEnabled()) {
        for (const a of toNotify) {
          await sendNtfyNotification({
            title: a.title,
            body: a.body,
            url: a.url,
            tags: ["newspaper"],
          }).catch((e) => {
            console.error("[NTFY] Failed to send notification:", e);
          });
        }
      }

      if (toNotify.length === 0) {
        console.log(`[SKIP] no new entries for ${url}`);
      }

      for (const a of toNotify) {
        const notified = {
          title: a.title,
          link: a.url,
          feedUrl: url,
          entryKey: a.entryKey,
          publishedAt: a.publishedAt,
          sentAt: new Date().toISOString(),
        };
        await recordNotification(notified);
        // Keep the in-memory history current so later articles in this run
        // can be deduplicated against it.
        history.unshift(notified);
        console.log(`[NOTIFIED] ${a.title}`);
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
