import express from "express";
import {
  DISCORD_WEBHOOK_URL,
  loadHistory,
  sendToDiscord,
  recordNotification,
} from "./lib.js";

const PORT = parseInt(process.env.GUI_PORT || "3334", 10);

if (!DISCORD_WEBHOOK_URL) {
  console.error("[ERROR] DISCORD_WEBHOOK_URL is not set");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function htmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(history, showSuccess, errorMessage) {
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

  const feedback = showSuccess
    ? `<div class="feedback success">✅ テスト通知を Discord に送信しました</div>`
    : errorMessage
    ? `<div class="feedback error">❌ エラー: ${htmlEscape(errorMessage)}</div>`
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
    input[name="title"] { width: 240px; }
    input[name="link"]  { width: 320px; }
    button { padding: 0.45rem 1rem; background: #0070f3; color: #fff; border: none; border-radius: 4px; font-size: 0.95rem; cursor: pointer; white-space: nowrap; }
    button:hover { background: #0051a8; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:hover td { background: #fafafa; }
    a { color: #0070f3; word-break: break-all; }
    code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.82em; word-break: break-all; }
    .empty { color: #888; text-align: center; padding: 2rem; }
  </style>
</head>
<body>
  <h1>🔔 News Alert Bot 管理画面</h1>

  <h2>テスト通知送信</h2>
  ${feedback}
  <form method="POST" action="/api/test-discord">
    <input type="text" name="title" placeholder="通知タイトル" required maxlength="200" value="テスト通知">
    <input type="url" name="link" placeholder="URL（省略可）" maxlength="2000">
    <button type="submit">Discord へ送信</button>
  </form>

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
</body>
</html>`;
}

app.get("/", async (req, res) => {
  try {
    const history = await loadHistory();
    const html = renderPage(
      history,
      req.query.status === "ok",
      req.query.error ? decodeURIComponent(req.query.error) : null
    );
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

app.post("/api/test-discord", async (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 200) || "テスト通知";
  const link = String(req.body?.link ?? "").trim().slice(0, 2000);

  try {
    await sendToDiscord(title, link);
    await recordNotification({
      title,
      link: link || null,
      feedUrl: null,
      sentAt: new Date().toISOString(),
    });
    res.redirect("/?status=ok");
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Admin GUI available at http://0.0.0.0:${PORT}`);
  console.log("[SERVER] ⚠️  No authentication is enforced — restrict access to trusted networks (LAN/VPN only).");
});
