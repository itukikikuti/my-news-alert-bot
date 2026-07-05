import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  loadHistory,
  loadRSSUrls,
  addRSSUrl,
  removeRSSUrl,
} from "./lib.js";
import {
  VAPID_PUBLIC_KEY,
  addSubscription,
  removeSubscription,
  loadSubscriptions,
  sendPushNotifications,
  isValidSubscription,
} from "./push.js";

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

function renderPage(history, pushFeedback) {
  const rows = history
    .map(
      (entry) => `
    <tr>
      <td>${htmlEscape(entry.sentAt)}</td>
      <td>${
        entry.link
          ? `<a href="${htmlEscape(entry.link)}" target="_blank" rel="noopener noreferrer">${htmlEscape(entry.title)}</a>`
          : htmlEscape(entry.title)
      }</td>
      <td><code>${htmlEscape(entry.feedUrl || "テスト送信")}</code></td>
    </tr>`
    )
    .join("");

  const vapidKeyScript = VAPID_PUBLIC_KEY
    ? `<script>window.VAPID_PUBLIC_KEY = ${JSON.stringify(VAPID_PUBLIC_KEY)};</script>`
    : "";

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
    .empty { color: #888; text-align: center; padding: 2rem; }
    #push-status { display: none; margin: 1rem 0; }
    #push-test-status { display: none; margin: 1rem 0; }
    #sub-list-status { display: none; margin: 1rem 0; }
    #rss-status { display: none; margin: 1rem 0; }
    .push-test-form { display: flex; flex-direction: column; gap: 0.5rem; max-width: 560px; }
    .push-test-form .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .push-test-form label { font-size: 0.9rem; min-width: 60px; }
    #sub-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
    #sub-table th, #sub-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e0e0e0; vertical-align: middle; }
    #sub-table th { background: #f5f5f5; }
    #rss-table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
    #rss-table th, #rss-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e0e0e0; vertical-align: middle; }
    #rss-table th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>🔔 News Alert Bot 管理画面</h1>

  <h2>📡 RSS フィード管理</h2>
  <div id="rss-status" class="feedback"></div>
  <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
    <input type="url" id="rss-add-input" placeholder="RSS フィード URL (https://...)" maxlength="2000" style="flex:1;min-width:200px;">
    <button id="rss-add-btn" type="button">追加</button>
  </div>
  <div id="rss-list-container" style="margin-top:0.5rem;"><p class="empty">読み込み中...</p></div>

  <h2>🔔 Web Push 購読</h2>
  <div id="push-status" class="feedback"></div>
  <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
    <button id="push-subscribe-btn" type="button">Push通知を購読する</button>
  </div>
  <p style="font-size:0.85rem;color:#666;margin-top:0.5rem;">Android Chrome でこのページを開き、「Push通知を購読する」で購読後、下のフォームで動作確認できます。</p>

  <h2>🧪 Web Push テスト送信</h2>
  <div id="push-test-status" class="feedback"></div>
  <div class="push-test-form">
    <div class="row">
      <label for="push-test-title">タイトル</label>
      <input type="text" id="push-test-title" placeholder="通知タイトル" maxlength="200" value="テスト通知" style="flex:1;">
    </div>
    <div class="row" style="align-items:flex-start;">
      <label for="push-test-body" style="padding-top:0.4rem;">本文</label>
      <textarea id="push-test-body" rows="2" placeholder="通知本文（省略可）" maxlength="500" style="flex:1;">Web Push 動作確認</textarea>
    </div>
    <div class="row">
      <label for="push-test-url">URL</label>
      <input type="url" id="push-test-url" placeholder="クリック時に開くURL（省略可）" maxlength="2000" style="flex:1;">
    </div>
    <div class="row">
      <button id="push-send-test-btn" type="button" class="secondary">Web Push をテスト送信</button>
    </div>
  </div>

  <h2>📋 購読管理</h2>
  <div id="sub-list-status" class="feedback"></div>
  <button id="sub-reload-btn" type="button" class="secondary" style="margin-bottom:0.5rem;">購読一覧を更新</button>
  <div id="sub-list-container"><p class="empty">読み込み中...</p></div>

  <h2>通知履歴（直近 ${history.length} 件）</h2>
  ${
    history.length === 0
      ? '<p class="empty">まだ通知はありません。</p>'
      : `<table>
    <thead>
      <tr><th>送信時刻 (UTC)</th><th>タイトル / リンク</th><th>フィード / 種別</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
  }
  ${vapidKeyScript}
  <script src="/push-client.js"></script>
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
    const urls = await loadRSSUrls();
    res.json(urls);
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
    const urls = await addRSSUrl(url);
    res.json({ ok: true, urls });
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
    const urls = await removeRSSUrl(url);
    res.json({ ok: true, urls });
  } catch (e) {
    console.error("[ERROR] Failed to remove RSS URL:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Web Push API
// ---------------------------------------------------------------------------

app.get("/api/push/subscriptions", async (req, res) => {
  try {
    const subscriptions = await loadSubscriptions();
    // Return only the endpoint (no keys) for display purposes
    const list = subscriptions.map((s) => ({ endpoint: s.endpoint }));
    res.json(list);
  } catch (e) {
    console.error("[ERROR] Failed to load subscriptions:", e);
    res.status(500).json({ error: "Failed to load subscriptions" });
  }
});

app.post("/api/push/subscribe", async (req, res) => {
  const sub = req.body;
  if (!isValidSubscription(sub)) {
    return res.status(400).json({ error: "Invalid subscription object" });
  }
  try {
    await addSubscription(sub);
    res.json({ ok: true });
  } catch (e) {
    console.error("[ERROR] Failed to save subscription:", e);
    res.status(500).json({ error: "Failed to save subscription" });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? "").trim();
  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }
  try {
    await removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (e) {
    console.error("[ERROR] Failed to remove subscription:", e);
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

app.post("/api/push/send", async (req, res) => {
  const { title, body, url, icon, badge, tag } = req.body ?? {};
  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }
  try {
    const result = await sendPushNotifications({ title, body, url, icon, badge, tag });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[ERROR] Failed to send push notifications:", e);
    res.status(500).json({ error: "Failed to send push notifications" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Admin GUI available at http://0.0.0.0:${PORT}`);
  console.log("[SERVER] ⚠️  No authentication is enforced — restrict access to trusted networks (LAN/VPN only).");
});
