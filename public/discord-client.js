/* discord-client.js – ブラウザ側 Discord テスト送信スクリプト */
(function () {
  "use strict";

  const testStatusEl = document.getElementById("discord-test-status");
  const testTitleEl = document.getElementById("discord-test-title");
  const testBodyEl = document.getElementById("discord-test-body");
  const testUrlEl = document.getElementById("discord-test-url");
  const sendTestBtn = document.getElementById("discord-send-test-btn");

  function setStatus(msg, isError) {
    if (!testStatusEl) return;
    testStatusEl.textContent = msg;
    testStatusEl.className = "feedback " + (isError ? "error" : "success");
    testStatusEl.style.display = "block";
  }

  async function sendTest() {
    const title = (testTitleEl?.value || "").trim();
    const body = (testBodyEl?.value || "").trim();
    const url = (testUrlEl?.value || "").trim();

    if (!title) {
      setStatus("❌ タイトルを入力してください。", true);
      return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      setStatus("❌ URL は http:// または https:// で始めてください。", true);
      return;
    }

    if (sendTestBtn) sendTestBtn.disabled = true;
    try {
      const res = await fetch("/api/discord/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: body || undefined, url: url || undefined }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("❌ 送信に失敗しました: " + (result.error || "HTTP " + res.status), true);
        return;
      }
      setStatus("✅ Discord にテスト送信しました。", false);
    } catch (err) {
      setStatus("❌ エラーが発生しました: " + err.message, true);
    } finally {
      if (sendTestBtn) sendTestBtn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (sendTestBtn) sendTestBtn.addEventListener("click", sendTest);
  });
})();
