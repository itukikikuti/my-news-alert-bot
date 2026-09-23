import Parser from "rss-parser";
import {
  cleanText,
  extractOriginalUrl,
  deriveEntryKey,
  loadState,
  saveState,
  loadRSSFeeds,
  recordNotification,
  recordSkipped,
  recordDelivery,
} from "./lib.js";
import { sendFcmNotification, isFcmEnabled } from "./fcm.js";
import { fetchArticleText } from "./article.js";
import { shouldNotify } from "./ai-filter.js";

const parser = new Parser();

// Maximum number of seen entry keys kept per feed to prevent unbounded state growth.
const MAX_SEEN_KEYS = 500;

// Google Alerts intermittently answers HTTP 500 for minutes at a time. Give a
// failing feed enough room to recover inside one run: 6 attempts with growing
// backoff, capped so a single feed cannot run past roughly one cron interval.
const FEED_FETCH_ATTEMPTS = 6;
const FEED_FETCH_BACKOFF_MS = 2000;
const FEED_FETCH_MAX_BACKOFF_MS = 15000;

async function parseFeedWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= FEED_FETCH_ATTEMPTS; attempt++) {
    try {
      return await parser.parseURL(url);
    } catch (e) {
      lastError = e;
      if (attempt < FEED_FETCH_ATTEMPTS) {
        const delay = Math.min(
          FEED_FETCH_BACKOFF_MS * attempt,
          FEED_FETCH_MAX_BACKOFF_MS
        );
        console.warn(
          `[FEED] attempt ${attempt}/${FEED_FETCH_ATTEMPTS} failed for ${url}: ${e.message} — retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

async function checkAndNotify() {
  const FEEDS = await loadRSSFeeds();
  if (FEEDS.length === 0) {
    throw new Error("No RSS URLs configured. Add URLs via the admin UI or set RSS_URLS env var as fallback.");
  }

  const state = await loadState();

  for (const feedConfig of FEEDS) {
    const url = feedConfig.url;
    const feedPrompt = feedConfig.prompt;
    try {
      const feed = await parseFeedWithRetry(url);
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
      // Every unseen entry is notified; there is no duplicate suppression.
      const orderedItems = [...items];
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
        // No prompt means no API call: notify every updated entry.
        // Fail-open: a disabled or failing filter still notifies.
        const decision = await shouldNotify({
          title,
          body: articleText || undefined,
          feedPrompt,
        });
        if (!decision.notify) {
          console.log(`[AI-SKIP] ${title} — ${decision.reason || ""}`);
          // Keep the skipped article visible in the admin UI, with the prompt
          // that decided it and the model's own reply.
          await recordSkipped({
            title,
            link,
            feedUrl: url,
            entryKey,
            publishedAt,
            sentAt: new Date().toISOString(),
            notified: false,
            feedPrompt: feedPrompt || "",
            aiReply: decision.rawReply || "",
            aiReason: decision.reason || "",
            aiSkipped: decision.skipped === true,
          });
          continue;
        }

        toNotify.push({
          title,
          body: articleText || undefined,
          url: link,
          entryKey,
          publishedAt,
          aiReply: decision.rawReply || "",
          aiReason: decision.reason || "",
          aiSkipped: decision.skipped === true,
        });
      }

      // Send notifications. FCM gets one message per article so the Android app
      // shows every article as its own notification. Space sends out with a
      // short gap: notifications fired milliseconds apart get collapsed by
      // Android into one, even with unique tags.
      const SEND_GAP_MS = 1500;

      if (isFcmEnabled()) {
        for (let i = 0; i < toNotify.length; i++) {
          const a = toNotify[i];
          if (i > 0) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
          let delivered = false;
          try {
            const r = await sendFcmNotification({
              title: a.title,
              body: a.body,
              url: a.url,
            });
            console.log(
              `[FCM] sent=${r.sent} failed=${r.failed} — ${a.title}`
            );
            delivered = r.sent > 0 && r.failed === 0;
            await recordDelivery({
              attemptedAt: new Date().toISOString(),
              status: delivered ? "accepted" : "failed",
              title: a.title,
              url: a.url,
              entryKey: a.entryKey,
              sent: r.sent,
              failed: r.failed,
              messageIds: r.messageIds,
              errors: r.errors,
            });
            if (!delivered) {
              console.error(`[FCM] delivery failed for: ${a.title}`);
            }
          } catch (e) {
            console.error("[FCM] Failed to send notification:", e);
            await recordDelivery({
              attemptedAt: new Date().toISOString(),
              status: "error",
              title: a.title,
              url: a.url,
              entryKey: a.entryKey,
              error: e.message,
            });
          }

          if (!delivered) {
            // It was tentatively added before AI evaluation. Remove it so the
            // next cron run retries instead of silently losing the article.
            seenKeys.delete(a.entryKey);
            continue;
          }

          const notified = {
            title: a.title,
            link: a.url,
            feedUrl: url,
            entryKey: a.entryKey,
            publishedAt: a.publishedAt,
            sentAt: new Date().toISOString(),
            notified: true,
            feedPrompt: feedPrompt || "",
            aiReply: a.aiReply || "",
            aiReason: a.aiReason || "",
            aiSkipped: a.aiSkipped === true,
          };
          await recordNotification(notified);
          console.log(`[NOTIFIED] ${a.title}`);
        }
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
