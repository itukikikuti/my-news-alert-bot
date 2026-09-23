import fs from "fs/promises";
import path from "path";

export const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
export const HISTORY_FILE =
  process.env.HISTORY_FILE ||
  path.join(path.dirname(STATE_FILE), "history.json");

// Dynamic getters allow tests to override STATE_FILE / HISTORY_FILE env vars
// at call-time.
function getStateFile() {
  return process.env.STATE_FILE || "/data/state.json";
}

function getHistoryFile() {
  if (process.env.HISTORY_FILE) return process.env.HISTORY_FILE;
  return path.join(path.dirname(getStateFile()), "history.json");
}

const HISTORY_MAX = 200;
const MAX_UNICODE_CODE_POINT = 0x10ffff;

function decodeHtmlEntities(text) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };

  const toSafeCodePoint = (value, radix) => {
    const codePoint = Number.parseInt(value, radix);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_UNICODE_CODE_POINT) {
      return "";
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "";
    }
  };

  return text
    .replace(/&#(\d+);/g, (_, dec) => toSafeCodePoint(dec, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => toSafeCodePoint(hex, 16))
    .replace(/&([a-z]+);/gi, (_, name) => entities[name.toLowerCase()] ?? `&${name};`);
}

function stripHtmlTags(text) {
  let inTag = false;
  let result = "";

  for (const ch of text) {
    if (ch === "<") {
      inTag = true;
      continue;
    }
    if (ch === ">") {
      inTag = false;
      continue;
    }
    if (!inTag) {
      result += ch;
    }
  }

  return result;
}

export function cleanText(input) {
  return stripHtmlTags(decodeHtmlEntities(String(input ?? "")))
    .replace(/\s+/g, " ")
    .trim();
}

// Fetch the feed's own title so a newly added feed is labelled automatically.
// Best effort: an unreachable feed still gets added, just without a title.
export async function fetchFeedTitle(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "news-alert-bot/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const match = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return "";
    const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    return cleanText(raw).slice(0, 200);
  } catch (e) {
    console.warn(`[FEED] Could not read title for ${url}: ${e.message}`);
    return "";
  }
}

/**
 * Derive a stable deduplication key for an RSS/Atom feed item.
 * Priority:
 *   1. entry.id / guid  (most stable Atom identifier)
 *   2. canonical target URL (Google redirect unwrapped)
 *   3. normalized title + published timestamp
 */export function deriveEntryKey(item) {
  const id = (item?.id || item?.guid || "").trim();
  if (id) return `id:${id}`;

  const link = extractOriginalUrl(item?.link || "");
  if (link) return `url:${link}`;

  const title = cleanText(item?.title || "");
  const pub = (item?.isoDate || item?.pubDate || item?.published || item?.updated || "").trim();
  return `title:${title}|pub:${pub}`;
}

export function extractOriginalUrl(rawLink) {
  const link = String(rawLink ?? "").trim();
  if (!link) return "";

  try {
    const parsed = new URL(link);
    const candidate = parsed.searchParams.get("url") || parsed.searchParams.get("q");
    if (candidate && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  } catch {
    return link;
  }

  return link;
}

export function formatPublishedAt(rawDate) {
  if (!rawDate) return "";
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${formatted} JST`;
}

export async function loadState() {
  const stateFile = getStateFile();
  try {
    const raw = await fs.readFile(stateFile, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load state file:", e);
    }
    return {};
  }
}

export async function saveState(state) {
  const stateFile = getStateFile();
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

export async function loadHistory() {
  const historyFile = getHistoryFile();
  try {
    const raw = await fs.readFile(historyFile, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load history file:", e);
    }
    return [];
  }
}

export async function saveHistory(history) {
  const historyFile = getHistoryFile();
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(historyFile, JSON.stringify(history, null, 2), "utf-8");
}

export async function recordNotification(entry) {
  const history = await loadHistory();
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  await saveHistory(history);
}

/** Append one durable delivery event for post-incident diagnosis. */
export async function recordDelivery(entry) {
  const file = path.join(path.dirname(getStateFile()), "delivery-log.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// RSS URL management
// ---------------------------------------------------------------------------

function getRSSUrlsFile() {
  if (process.env.RSS_URLS_FILE) return process.env.RSS_URLS_FILE;
  return path.join(path.dirname(getStateFile()), "rss-urls.json");
}

export async function loadRSSUrls() {
  return (await loadRSSFeeds()).map((f) => f.url);
}

/**
 * Load configured RSS feeds as objects: { url, prompt }.
 * Backward compatible with the legacy format (plain array of URL strings).
 */
export async function loadRSSFeeds() {
  const file = getRSSUrlsFile();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map((entry) => {
          if (typeof entry === "string") {
            return { url: entry.trim(), prompt: "", title: "" };
          }
          if (entry && typeof entry.url === "string" && entry.url.trim()) {
            return {
              url: entry.url.trim(),
              prompt: typeof entry.prompt === "string" ? entry.prompt : "",
              title: typeof entry.title === "string" ? entry.title : "",
            };
          }
          return null;
        })
        .filter(Boolean);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load RSS URLs file:", e);
    }
  }
  // Fall back to environment variable
  return (
    process.env.RSS_URLS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((url) => ({ url, prompt: "", title: "" })) ?? []
  );
}

export async function saveRSSUrls(urls) {
  const file = getRSSUrlsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(urls, null, 2), "utf-8");
}

/** Save feed objects ({ url, prompt }) to disk. */
export async function saveRSSFeeds(feeds) {
  const file = getRSSUrlsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(feeds, null, 2), "utf-8");
}

/** Update the per-feed AI prompt. Returns the updated feed list. */
export async function setFeedPrompt(url, prompt) {
  const trimmed = String(url ?? "").trim();
  const feeds = await loadRSSFeeds();
  const idx = feeds.findIndex((f) => f.url === trimmed);
  if (idx < 0) {
    throw new Error("URL not found");
  }
  feeds[idx] = { ...feeds[idx], prompt: String(prompt ?? "") };
  await saveRSSFeeds(feeds);
  return feeds;
}

/** Update the cached display title of a feed. Returns the updated feed list. */
export async function setFeedTitle(url, title) {
  const trimmed = String(url ?? "").trim();
  const feeds = await loadRSSFeeds();
  const idx = feeds.findIndex((f) => f.url === trimmed);
  if (idx < 0) {
    throw new Error("URL not found");
  }
  feeds[idx] = { ...feeds[idx], title: String(title ?? "") };
  await saveRSSFeeds(feeds);
  return feeds;
}

export function isValidRSSUrl(url) {
  if (typeof url !== "string") return false;
  return /^https?:\/\/.+/i.test(url.trim());
}

export async function addRSSUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (!isValidRSSUrl(trimmed)) {
    throw new Error("Invalid URL: must start with http:// or https://");
  }
  const feeds = await loadRSSFeeds();
  if (feeds.some((f) => f.url === trimmed)) {
    throw new Error("URL already exists");
  }
  // Label the feed from its own <title> so the name appears without manual entry.
  const title = await fetchFeedTitle(trimmed);
  feeds.push({ url: trimmed, prompt: "", title });
  await saveRSSFeeds(feeds);
  return feeds;
}

export async function removeRSSUrl(url) {
  const trimmed = String(url ?? "").trim();
  const feeds = await loadRSSFeeds();
  const filtered = feeds.filter((f) => f.url !== trimmed);
  await saveRSSFeeds(filtered);
  return filtered;
}
