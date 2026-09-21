import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadHistory,
  loadRSSFeeds,
  addRSSUrl,
  removeRSSUrl,
  setFeedPrompt,
} from "./lib.js";
import { sendNtfyNotification, isNtfyEnabled } from "./ntfy.js";
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

function renderPage(history) {
  const aiFilterEnabled = isAiFilterEnabled();
  const rows = history
    .map(
      (entry) => `
    <tr>
      <td>${htmlEscape(formatJst(entry.sentAt))}</td>
      <td>${
        entry.link
          ? `<a href="${htmlEscape(entry.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(entry.title)}</a>`
          : htmlEscape(entry.title)
      }</td>
      <td><code>${htmlEscape(entry.feedUrl || "テスト送信")}</code></td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>News Alert Bot - 管理画面</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #333; }
    h1 { font-size: 1.6rem; border-bottom: 2px solid #0070f3; padding-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; }
    .feedback { padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; font-weight: 500; }
    .success { background: #d4edda; color: #155724; }
    .error   { background: #f8d7da; color: #721c24; }
    form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    input[type="text"], input[type="url"] { padding: 0.45rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; }
    textarea { padding: 0.45rem 0.6rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; width: 100%; resize: vertical; }
    button { padding: 0.45rem 1rem; background: #0070f3; color: #fff; border: none; border-radius: 4px; font-size: 0.95rem; cursor: pointer; white-space: nowrap; }
    button:hover { background: #0051a8; }
    button.secondary { background: #6c757d; }
    button.secondary:hover { background: #5a6268; }
    button.danger { background: #dc3545; }
    button.danger:hover { background: #b02a37; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:hover td { background: #fafafa; }
    a { color: #0070f3; word-break: break-all; }
    code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.82em; word-break: break-all; }
    /* Feed URLs are long and must not collapse into one character per line on
       narrow screens. Allow them to break at any character but keep them
       left-aligned and on a sane minimum width. */
    #rss-table td:nth-child(2) { min-width: 12rem; }
    #rss-table td:nth-child(2) code {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-all;
      display: inline;
      text-align: left;
    }
    .empty { color: #888; text-align: center; padding: 2rem; }
    #rss-status { display: none; margin: 1rem 0; }
    .test-form { display: flex; flex-direction: column; gap: 0.5rem; max-width: 560px; }
    .test-form .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .test-form label { font-size: 0.9rem; min-width: 60px; }
    #sub-table, #rss-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e0e0e0; vertical-align: middle; }
    th { background: #f5f5f5; }
    .prompt-box { display: flex; flex-direction: column; gap: 0.35rem; min-width: 240px; }
    .prompt-box textarea { font-size: 0.82rem; }
    .prompt-box button { align-self: flex-end; padding: 0.3rem 0.8rem; font-size: 0.82rem; }
  </style>
</head>
<body>
  <h1>🔔 News Alert Bot 管理画面</h1>
  <p style="font-size:0.85rem;color:#666;">AI判定: ${aiFilterEnabled ? "<strong style='color:#155724;'>有効</strong>" : "<strong style='color:#721c24;'>無効（OLLAMA_API_KEY 未設定）</strong>"} — 各フィードの「通知プロンプト」に従って通知可否を判定します。</p>

  <h2>📱 Android アプリ</h2>
  <p style="font-size:0.9rem;">
    <a href="/download/apk" style="display:inline-block;background:#0070f3;color:#fff;text-decoration:none;padding:0.6rem 1.2rem;border-radius:6px;font-weight:bold;">
      ⬇️ News Alert アプリをダウンロード (APK)
    </a>
  </p>
  <p style="font-size:0.8rem;color:#666;">ダウンロード後、ファイルアプリから APK を開いてインストールしてください（「提供元不明のアプリ」の許可が必要です）。</p>

  <h2>📡 RSS フィード管理</h2>
  <div id="rss-status" class="feedback"></div>
  <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
    <input type="url" id="rss-add-input" placeholder="RSS フィード URL (https://...)" maxlength="2000" style="flex:1;min-width:200px;">
    <button id="rss-add-btn" type="button">追加</button>
  </div>
  <div id="rss-list-container" style="margin-top:0.5rem;"><p class="empty">読み込み中...</p></div>

  <h2>通知履歴（直近 ${history.length} 件）</h2>
  ${
    history.length === 0
      ? '<p class="empty">まだ通知はありません。</p>'
      : `<table>
    <thead>
      <tr><th>送信時刻 (JST)</th><th>タイトル / リンク</th><th>フィード / 種別</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
  }
  <script src="/rss-client.js"></script>
</body>
</html>`;
}

app.get("/", async (req, res) => {
  try {
    const history = await loadHistory();
    const html = renderPage(history);
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
