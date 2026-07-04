import fs from "fs/promises";
import path from "path";

export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
export const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
export const HISTORY_FILE =
  process.env.HISTORY_FILE ||
  path.join(path.dirname(STATE_FILE), "history.json");

const HISTORY_MAX = 200;
const SUMMARY_MAX_LENGTH = 120;
const MAX_UNICODE_CODEPOINT = 0x10ffff;
const ELLIPSIS_LENGTH = 1;

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
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > MAX_UNICODE_CODEPOINT) {
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

export function cleanText(input) {
  return decodeHtmlEntities(String(input ?? ""))
    .replace(/<[^>]*>?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - ELLIPSIS_LENGTH)).trimEnd()}…`;
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

export function buildNotificationMessage({ title, summary, publishedAt, link }) {
  const cleanTitle = cleanText(title) || "(no title)";
  const cleanSummary = cleanText(summary);
  const cleanLink = extractOriginalUrl(link);
  const lines = [
    "🔔 **新着ニュース**",
    `**見出し**: ${cleanTitle}`,
  ];

  if (cleanSummary) {
    lines.push(`**要約**: ${truncateText(cleanSummary, SUMMARY_MAX_LENGTH)}`);
  }
  if (publishedAt) {
    const formatted = formatPublishedAt(publishedAt);
    if (formatted) {
      lines.push(`**公開**: ${formatted}`);
    }
  }
  if (cleanLink) {
    lines.push(`**リンク**: ${cleanLink}`);
  }

  return lines.join("\n");
}

export async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load state file:", e);
    }
    return {};
  }
}

export async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[WARN] Failed to load history file:", e);
    }
    return [];
  }
}

export async function saveHistory(history) {
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
}

export async function recordNotification(entry) {
  const history = await loadHistory();
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  await saveHistory(history);
}

export async function sendToDiscord(title, link, options = {}) {
  const content = buildNotificationMessage({
    title,
    link,
    summary: options.summary,
    publishedAt: options.publishedAt,
  });
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
}
