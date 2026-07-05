import fs from "fs/promises";
import path from "path";

export const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
export const HISTORY_FILE =
  process.env.HISTORY_FILE ||
  path.join(path.dirname(STATE_FILE), "history.json");

// Dynamic getters allow tests to override STATE_FILE / HISTORY_FILE env vars
// at call-time, matching the pattern used in push.js for SUBSCRIPTIONS_FILE.
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

/**
 * Derive a stable deduplication key for an RSS/Atom feed item.
 * Priority:
 *   1. entry.id / guid  (most stable Atom identifier)
 *   2. canonical target URL (Google redirect unwrapped)
 *   3. normalized title + published timestamp
 */
export function deriveEntryKey(item) {
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

// ---------------------------------------------------------------------------
// RSS URL management
// ---------------------------------------------------------------------------

function getRSSUrlsFile() {
  if (process.env.RSS_URLS_FILE) return process.env.RSS_URLS_FILE;
  return path.join(path.dirname(getStateFile()), "rss-urls.json");
}

export async function loadRSSUrls() {
  const file = getRSSUrlsFile();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((u) => typeof u === "string" && u.trim());
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load RSS URLs file:", e);
    }
  }
  // Fall back to environment variable
  return process.env.RSS_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
}

export async function saveRSSUrls(urls) {
  const file = getRSSUrlsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(urls, null, 2), "utf-8");
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
  const urls = await loadRSSUrls();
  if (urls.includes(trimmed)) {
    throw new Error("URL already exists");
  }
  urls.push(trimmed);
  await saveRSSUrls(urls);
  return urls;
}

export async function removeRSSUrl(url) {
  const trimmed = String(url ?? "").trim();
  const urls = await loadRSSUrls();
  const filtered = urls.filter((u) => u !== trimmed);
  await saveRSSUrls(filtered);
  return filtered;
}
