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
    <tr>
      <td class="col-time">${htmlEscape(formatJst(entry.sentAt))}</td>
      <td class="col-title">${
        entry.link
          ? `<a href="${htmlEscape(entry.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(entry.title)}</a>`
          : htmlEscape(entry.title)
      }</td>
      <td class="col-feed">${htmlEscape(feedTitle)}</td>
    </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>News Alert Bot - 管理画面</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --panel-2: #1e222b;
      --border: #2a2f3a;
      --text: #e6e9ef;
      --muted: #9aa4b2;
      --accent: #4c8dff;
      --accent-hover: #6ba0ff;
      --danger: #e5484d;
      --success: #3fb950;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
      margin: 0;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 2rem 1rem 4rem; }
    header { padding: 0 0 1.25rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0 0 0.5rem; letter-spacing: 0.01em; }
    h1 .dot { color: var(--accent); }
    .status { font-size: 0.85rem; color: var(--muted); }
    .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
    .badge.on { background: rgba(63,185,80,0.15); color: var(--success); border: 1px solid rgba(63,185,80,0.35); }
    .badge.off { background: rgba(229,72,77,0.12); color: var(--danger); border: 1px solid rgba(229,72,77,0.3); }
    section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem 1.25rem 1.5rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.02rem; font-weight: 650; margin: 0 0 0.9rem; color: var(--text); }
    .feedback { padding: 0.6rem 0.9rem; border-radius: 8px; margin: 0 0 1rem; font-size: 0.9rem; display: none; }
    .feedback.show { display: block; }
    .success { background: rgba(63,185,80,0.12); color: var(--success); border: 1px solid rgba(63,185,80,0.3); }
    .error { background: rgba(229,72,77,0.12); color: var(--danger); border: 1px solid rgba(229,72,77,0.3); }
    input[type="text"], input[type="url"], textarea {
      padding: 0.55rem 0.75rem;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 0.95rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s ease;
    }
    input:focus, textarea:focus { border-color: var(--accent); }
    ::placeholder { color: #66707e; }
    textarea { width: 100%; resize: vertical; }
    button {
      padding: 0.55rem 1.1rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      transition: background 0.15s ease, transform 0.05s ease;
    }
    button:hover { background: var(--accent-hover); }
    button:active { transform: translateY(1px); }
    button.secondary { background: #333a47; color: var(--text); }
    button.secondary:hover { background: #3d4554; }
    button.danger { background: transparent; color: var(--danger); border: 1px solid rgba(229,72,77,0.4); }
    button.danger:hover { background: rgba(229,72,77,0.12); }
    .apk-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--accent);
      color: #fff;
      text-decoration: none;
      padding: 0.7rem 1.3rem;
      border-radius: 8px;
      font-weight: 650;
      font-size: 0.95rem;
      transition: background 0.15s ease;
    }
    .apk-btn:hover { background: var(--accent-hover); }
    .hint { font-size: 0.82rem; color: var(--muted); margin: 0.6rem 0 0; }
    .add-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .add-row input { flex: 1; min-width: 220px; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
    a:hover { text-decoration: underline; }
    .feed-name { font-weight: 600; }
    .feed-url { display: block; font-size: 0.78rem; color: var(--muted); overflow-wrap: anywhere; margin-top: 0.15rem; }
    .col-time { white-space: nowrap; color: var(--muted); font-size: 0.82rem; width: 11rem; }
    .empty { color: var(--muted); text-align: center; padding: 1.5rem; }
    #rss-status { display: none; margin: 1rem 0; }
    #rss-table { table-layout: fixed; }
    #rss-table th:nth-child(1), #rss-table td:nth-child(1) { width: 2rem; }
    #rss-table th:nth-child(2), #rss-table td:nth-child(2) { width: 42%; }
    #rss-table th:nth-child(4), #rss-table td:nth-child(4) { width: 4.5rem; text-align: right; }
    #rss-table td { overflow-wrap: anywhere; }
    .prompt-box { display: flex; flex-direction: column; gap: 0.35rem; }
    .prompt-box textarea { font-size: 0.82rem; width: 100%; }
    .prompt-box button { align-self: flex-end; padding: 0.35rem 0.85rem; font-size: 0.8rem; }
    .feed-box { display: flex; flex-direction: column; gap: 0.3rem; }
    .feed-title-input {
      font-size: 0.9rem;
      font-weight: 600;
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0.25rem 0.4rem;
    }
    .feed-title-input:hover { border-color: var(--border); }
    .feed-title-input:focus { background: var(--panel-2); border-color: var(--accent); }
    .feed-url { display: block; font-size: 0.78rem; color: var(--muted); overflow-wrap: anywhere; margin-top: 0.15rem; padding-left: 0.4rem; }
    @media (max-width: 600px) {
      .wrap { padding: 1.25rem 0.75rem 3rem; }
      #rss-table, #rss-table thead, #rss-table tbody, #rss-table tr, #rss-table th, #rss-table td { display: block; width: auto; }
      #rss-table thead { display: none; }
      #rss-table tr { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 0.8rem; padding: 0.6rem 0.7rem; background: var(--panel-2); }
      #rss-table td { border: none; padding: 0.2rem 0; text-align: left; }
      #rss-table td:nth-child(1) { display: none; }
      #rss-table td:nth-child(4) { text-align: right; }
      #rss-table .feed-title-input { text-align: left; padding-left: 0.4rem; }
      #rss-table .feed-url { padding-left: 0.4rem; text-align: left; }
      /* Keep the send time visible on phones instead of hiding the column. */
      .col-time { width: auto; display: block; margin-bottom: 0.15rem; }
      .log-table th:nth-child(1), .log-table td:nth-child(1) { display: block; }
      .log-table th:nth-child(3), .log-table td:nth-child(3) { font-size: 0.8rem; color: var(--muted); }
    }
  </style>
</head>
<body>
  <div class="wrap">
  <header>
    <h1>News Alert Bot <span class="dot">●</span></h1>
    <div class="status">AI判定: ${
      aiFilterEnabled
        ? '<span class="badge on">有効</span>'
        : '<span class="badge off">無効</span> （OLLAMA_API_KEY 未設定）'
    } — 各フィードの「通知プロンプト」に従って通知可否を判定します</div>
  </header>

  <section>
    <h2>Android アプリ</h2>
    <p><a class="apk-btn" href="/download/apk">News Alert アプリをダウンロード (APK)</a></p>
    <p class="hint">ダウンロード後、ファイルアプリから APK を開いてインストールしてください（「提供元不明のアプリ」の許可が必要です）。</p>
  </section>

  <section>
    <h2>RSS フィード管理</h2>
    <div id="rss-status" class="feedback"></div>
    <div class="add-row">
      <input type="url" id="rss-add-input" placeholder="RSS フィード URL (https://...)" maxlength="2000">
      <button id="rss-add-btn" type="button">追加</button>
    </div>
    <div id="rss-list-container" style="margin-top:0.6rem;"><p class="empty">読み込み中...</p></div>
  </section>

  <section>
    <h2>通知履歴（直近 ${history.length} 件）</h2>
    ${
      history.length === 0
        ? '<p class="empty">まだ通知はありません。</p>'
        : `<table class="log-table">
      <thead>
        <tr><th>送信時刻 (JST)</th><th>タイトル / リンク</th><th>フィード</th></tr>
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
