import Parser from "rss-parser";
import fs from "fs/promises";
import path from "path";

const parser = new Parser();

const RSS_URLS = process.env.RSS_URLS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "/data/state.json";

if (!DISCORD_WEBHOOK_URL) {
  throw new Error("DISCORD_WEBHOOK_URL is not set");
}
if (RSS_URLS.length === 0) {
  throw new Error("RSS_URLS is not set");
}

async function loadState() {
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

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

async function sendToDiscord(title, link) {
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

async function checkAndNotify() {
  const state = await loadState();

  for (const url of RSS_URLS) {
    try {
      const feed = await parser.parseURL(url);
      const latest = feed.items?.[0];
      if (!latest) continue;

      const entryId = latest.guid || latest.id || latest.link || latest.title;
      const title = latest.title ?? "(no title)";
      const link = latest.link ?? "";

      const lastId = state[url];
      if (entryId && entryId !== lastId) {
        await sendToDiscord(title, link);
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
