import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadHistory,
  loadRSSFeeds,
  addRSSUrl,
  removeRSSUrl,
  setFeedPrompt,
  setFeedTitle,
} from "./lib.js";
import { isAiFilterEnabled } from "./ai-filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.GUI_PORT || "3334", 10);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function htmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format an ISO timestamp for display in Asia/Tokyo (JST).
function formatJst(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString ?? "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function renderPage(history, feeds) {
  const aiFilterEnabled = isAiFilterEnabled();
  // Map feed URL -> display title, so the log shows a name instead of a URL.
  const feedTitles = new Map(
    (feeds || []).map((f) => [f.url, (f.title || "").trim()])
  );
  const rows = history
    .map((entry) => {
      const feedTitle =
        feedTitles.get(entry.feedUrl) || entry.feedTitle || entry.feedUrl || "テスト送信";
      return `
    <tr class="border-b border-slate-100 align-top hover:bg-slate-50">
      <td class="whitespace-nowrap py-2.5 pr-4 text-xs text-slate-500">${htmlEscape(formatJst(entry.sentAt))}</td>
      <td class="py-2.5 pr-4">${
        entry.link
          ? `<a class="text-blue-600 hover:underline" href="${htmlEscape(entry.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(entry.title)}</a>`
          : htmlEscape(entry.title)
      }</td>
      <td class="py-2.5 text-slate-600">${htmlEscape(feedTitle)}</td>
    </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>News Alert Bot - 管理画面</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="bg-slate-50 text-slate-800 antialiased">
  <div class="mx-auto max-w-3xl px-4 py-8 sm:py-12">
    <header class="mb-8 flex items-baseline justify-between border-b border-slate-200 pb-5">
      <div>
        <h1 class="text-xl font-bold tracking-tight text-slate-900">News Alert Bot</h1>
        <p class="mt-1 text-sm text-slate-500">
          AI判定:
          ${
            aiFilterEnabled
              ? '<span class="ml-1 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">有効</span>'
              : '<span class="ml-1 inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-600/20">無効</span>'
          }
          — 各フィードの「通知プロンプト」に従って通知可否を判定します
        </p>
      </div>
    </header>

    <section class="mb-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="mb-4 text-base font-semibold text-slate-900">Android アプリ</h2>
      <a class="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700" href="/download/apk">News Alert アプリをダウンロード (APK)</a>
      <p class="mt-3 text-xs text-slate-500">ダウンロード後、ファイルアプリから APK を開いてインストールしてください（「提供元不明のアプリ」の許可が必要です）。</p>
    </section>

    <section class="mb-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="mb-4 text-base font-semibold text-slate-900">RSS フィード管理</h2>
      <div id="rss-status" class="mb-3 hidden rounded-lg px-3 py-2 text-sm"></div>
      <div class="flex flex-wrap items-center gap-2">
        <input type="url" id="rss-add-input" placeholder="RSS フィード URL (https://...)" maxlength="2000"
          class="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20">
        <button id="rss-add-btn" type="button"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700">追加</button>
      </div>
      <div id="rss-list-container" class="mt-4"><p class="py-6 text-center text-sm text-slate-400">読み込み中...</p></div>
    </section>

    <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="mb-4 text-base font-semibold text-slate-900">通知履歴（直近 ${history.length} 件）</h2>
      ${
        history.length === 0
          ? '<p class="py-6 text-center text-sm text-slate-400">まだ通知はありません。</p>'
          : `<table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
            <th class="py-2 pr-4">送信時刻 (JST)</th><th class="py-2 pr-4">タイトル / リンク</th><th class="py-2">フィード</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
      }
    </section>
  </div>
  <script src="/rss-client.js"></script>
</body>
</html>`;

}

app.get("/", async (req, res) => {
  try {
    const [history, feeds] = await Promise.all([loadHistory(), loadRSSFeeds()]);
    const html = renderPage(history, feeds);
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    console.error("[ERROR] Failed to render admin page:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Serve the Android APK for sideloading. The file is mounted at /apk.
app.get("/download/apk", (req, res) => {
  const apkPath = process.env.APK_PATH || "/apk/NewsAlert.apk";
  res.download(apkPath, "NewsAlert.apk", (err) => {
    if (err) {
      console.error("[ERROR] Failed to serve APK:", err.message);
      if (!res.headersSent) res.status(404).send("APK not found");
    }
  });
});

app.get("/api/history", async (req, res) => {
  try {
    const history = await loadHistory();
    res.json(history);
  } catch (e) {
    console.error("[ERROR] Failed to load history:", e);
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ---------------------------------------------------------------------------
// RSS URL management API
// ---------------------------------------------------------------------------

app.get("/api/rss", async (req, res) => {
  try {
    const feeds = await loadRSSFeeds();
    res.json(feeds);
  } catch (e) {
    console.error("[ERROR] Failed to load RSS URLs:", e);
    res.status(500).json({ error: "Failed to load RSS URLs" });
  }
});

app.post("/api/rss", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  try {
    const feeds = await addRSSUrl(url);
    res.json({ ok: true, feeds });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/rss", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  try {
    const feeds = await removeRSSUrl(url);
    res.json({ ok: true, feeds });
  } catch (e) {
    console.error("[ERROR] Failed to remove RSS URL:", e);
    res.status(500).json({ error: e.message });
  }
});

// Update the cached display title of a feed.
app.put("/api/rss/title", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  const title = String(req.body?.title ?? "");
  if (title.length > 200) {
    return res.status(400).json({ error: "title is too long (max 200 chars)" });
  }
  try {
    const feeds = await setFeedTitle(url, title);
    res.json({ ok: true, feeds });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update the per-feed AI prompt (used to decide whether to notify).
app.put("/api/rss/prompt", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  const prompt = String(req.body?.prompt ?? "");
  if (prompt.length > 2000) {
    return res.status(400).json({ error: "prompt is too long (max 2000 chars)" });
  }
  try {
    const feeds = await setFeedPrompt(url, prompt);
    res.json({ ok: true, feeds });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Admin GUI available at http://0.0.0.0:${PORT}`);
  console.log("[SERVER] ⚠️  No authentication is enforced — restrict access to trusted networks (LAN/VPN only).");
});
