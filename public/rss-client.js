/* rss-client.js – ブラウザ側 RSS フィード管理スクリプト */
(function () {
  "use strict";

  const rssStatusEl = document.getElementById("rss-status");
  const rssAddInput = document.getElementById("rss-add-input");
  const rssAddBtn = document.getElementById("rss-add-btn");
  const rssListContainer = document.getElementById("rss-list-container");

  function setRSSStatus(msg, isError) {
    if (!rssStatusEl) return;
    rssStatusEl.textContent = msg;
    rssStatusEl.className = "feedback " + (isError ? "error" : "success");
    rssStatusEl.style.display = "block";
  }

  async function loadRSSList() {
    if (!rssListContainer) return;
    try {
      const res = await fetch("/api/rss");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const list = await res.json();

      if (!Array.isArray(list) || list.length === 0) {
        rssListContainer.innerHTML = '<p class="empty">監視中の RSS フィードはありません。</p>';
        return;
      }

      // Build table using DOM APIs to avoid XSS from feed values
      const table = document.createElement("table");
      table.id = "rss-table";
      const thead = table.createTHead();
      const headerRow = thead.insertRow();
      ["#", "RSS フィード URL", "通知プロンプト (AI判定)", "操作"].forEach((text) => {
        const th = document.createElement("th");
        th.textContent = text;
        headerRow.appendChild(th);
      });
      const tbody = table.createTBody();

      list.forEach((feed, i) => {
        const url = typeof feed === "string" ? feed : feed.url;
        const prompt = typeof feed === "string" ? "" : feed.prompt || "";

        const row = tbody.insertRow();
        row.insertCell().textContent = String(i + 1);

        const urlCell = row.insertCell();
        const code = document.createElement("code");
        code.textContent = url;
        urlCell.appendChild(code);

        // Per-feed AI prompt: textarea + save button
        const promptCell = row.insertCell();
        const promptBox = document.createElement("div");
        promptBox.className = "prompt-box";
        const textarea = document.createElement("textarea");
        textarea.rows = 2;
        textarea.maxLength = 2000;
        textarea.placeholder = "例: 広島カープのチケット販売情報以外は通知しないでください";
        textarea.value = prompt;
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "secondary";
        saveBtn.textContent = "保存";
        saveBtn.addEventListener("click", () => savePrompt(url, textarea.value, saveBtn));
        promptBox.appendChild(textarea);
        promptBox.appendChild(saveBtn);
        promptCell.appendChild(promptBox);

        const btnCell = row.insertCell();
        const btn = document.createElement("button");
        btn.className = "danger";
        btn.textContent = "削除";
        btn.addEventListener("click", () => deleteRSSUrl(url));
        btnCell.appendChild(btn);
      });

      rssListContainer.replaceChildren(table);
    } catch (err) {
      rssListContainer.innerHTML = "";
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "読み込みに失敗しました: " + err.message;
      rssListContainer.appendChild(p);
    }
  }

  async function addRSSUrl() {
    const url = (rssAddInput?.value || "").trim();
    if (!url) {
      setRSSStatus("❌ URL を入力してください。", true);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setRSSStatus("❌ URL は http:// または https:// で始めてください。", true);
      return;
    }

    try {
      const res = await fetch("/api/rss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRSSStatus("❌ 追加に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("✅ RSS フィードを追加しました。", false);
      if (rssAddInput) rssAddInput.value = "";
      loadRSSList();
    } catch (err) {
      setRSSStatus("❌ エラーが発生しました: " + err.message, true);
    }
  }

  async function deleteRSSUrl(url) {
    try {
      const res = await fetch("/api/rss", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRSSStatus("❌ 削除に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("✅ RSS フィードを削除しました。", false);
      loadRSSList();
    } catch (err) {
      setRSSStatus("❌ 削除でエラーが発生しました: " + err.message, true);
    }
  }

  async function savePrompt(url, prompt, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/rss/prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, prompt }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRSSStatus("❌ プロンプトの保存に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("✅ プロンプトを保存しました。", false);
    } catch (err) {
      setRSSStatus("❌ 保存でエラーが発生しました: " + err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadRSSList();

    if (rssAddBtn) {
      rssAddBtn.addEventListener("click", () => addRSSUrl());
    }

    if (rssAddInput) {
      rssAddInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addRSSUrl();
      });
    }
  });
})();
