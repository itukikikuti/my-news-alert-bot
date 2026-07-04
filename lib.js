import fs from "fs/promises";
import path from "path";

export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
export const STATE_FILE = process.env.STATE_FILE || "/data/state.json";
export const HISTORY_FILE =
  process.env.HISTORY_FILE ||
  path.join(path.dirname(STATE_FILE), "history.json");

const HISTORY_MAX = 200;

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

export async function sendToDiscord(title, link) {
  const content = `🔔 **新着ニュース！**\n【${title}】\n${link}`;
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
