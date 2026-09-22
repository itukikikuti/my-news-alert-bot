/* rss-client.js – ブラウザ側 RSS フィード管理スクリプト（Tailwind 版） */
(function () {
  "use strict";

  const rssStatusEl = document.getElementById("rss-status");
  const rssAddInput = document.getElementById("rss-add-input");
  const rssAddBtn = document.getElementById("rss-add-btn");
  const rssListContainer = document.getElementById("rss-list-container");

  function setRSSStatus(msg, isError) {
    if (!rssStatusEl) return;
    rssStatusEl.textContent = msg;
    rssStatusEl.className =
      "mb-3 rounded-lg px-3 py-2 text-sm " +
      (isError
        ? "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20"
        : "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20");
  }

  function emptyNote(text) {
    const p = document.createElement("p");
    p.className = "py-6 text-center text-sm text-slate-400";
    p.textContent = text;
    return p;
  }

  async function loadRSSList() {
    if (!rssListContainer) return;
    try {
      const res = await fetch("/api/rss");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const list = await res.json();

      if (!Array.isArray(list) || list.length === 0) {
        rssListContainer.replaceChildren(emptyNote("監視中の RSS フィードはありません。"));
        return;
      }

      // Build table using DOM APIs to avoid XSS from feed values
      const table = document.createElement("table");
      table.className = "w-full text-sm";
      const thead = table.createTHead();
      const headerRow = thead.insertRow();
      headerRow.className =
        "border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wide text-slate-400";
      ["#", "フィード", "通知プロンプト (AI判定)", "操作"].forEach((text) => {
        const th = document.createElement("th");
        th.className = "py-2 pr-4";
        th.textContent = text;
        headerRow.appendChild(th);
      });
      const tbody = table.createTBody();

      list.forEach((feed, i) => {
        const url = typeof feed === "string" ? feed : feed.url;
        const prompt = typeof feed === "string" ? "" : feed.prompt || "";
        const title = typeof feed === "string" ? "" : feed.title || "";

        const row = tbody.insertRow();
        row.className = "border-b border-slate-100 align-top";

        const numCell = row.insertCell();
        numCell.className = "py-3 pr-4 text-slate-400";
        numCell.textContent = String(i + 1);

        // Feed cell: editable title + the underlying URL.
        const feedCell = row.insertCell();
        feedCell.className = "py-3 pr-4";
        const box = document.createElement("div");
        box.className = "flex flex-col gap-1";

        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.maxLength = 200;
        titleInput.placeholder = "フィード名（表示用）";
        titleInput.value = title;
        titleInput.className =
          "w-full rounded-md border border-slate-300 px-2 py-1 text-sm font-semibold outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";

        const urlLine = document.createElement("span");
        urlLine.className = "block text-xs text-slate-400 [overflow-wrap:anywhere]";
        urlLine.textContent = url;

        box.appendChild(titleInput);
        box.appendChild(urlLine);
        feedCell.appendChild(box);

        titleInput.addEventListener("blur", () => saveTitle(url, titleInput.value));
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            titleInput.blur();
          }
        });

        // Per-feed AI prompt: textarea + save button
        const promptCell = row.insertCell();
        promptCell.className = "py-3 pr-4";
        const promptBox = document.createElement("div");
        promptBox.className = "flex flex-col items-end gap-1";
        const textarea = document.createElement("textarea");
        textarea.rows = 2;
        textarea.maxLength = 2000;
        textarea.placeholder = "例: 広島カープのチケット販売情報以外は通知しないでください";
        textarea.value = prompt;
        textarea.className =
          "w-full rounded-md border border-slate-300 px-2 py-1 text-xs outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "保存";
        saveBtn.className =
          "rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50";
        saveBtn.addEventListener("click", () => savePrompt(url, textarea.value, saveBtn));
        promptBox.appendChild(textarea);
        promptBox.appendChild(saveBtn);
        promptCell.appendChild(promptBox);

        const btnCell = row.insertCell();
        btnCell.className = "py-3 text-right";
        const btn = document.createElement("button");
        btn.textContent = "削除";
        btn.className =
          "rounded-md border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50";
        btn.addEventListener("click", () => deleteRSSUrl(url));
        btnCell.appendChild(btn);
      });

      rssListContainer.replaceChildren(table);
    } catch (err) {
      rssListContainer.replaceChildren(
        emptyNote("読み込みに失敗しました: " + err.message)
      );
    }
  }

  async function addRSSUrl() {
    const url = (rssAddInput?.value || "").trim();
    if (!url) {
      setRSSStatus("URL を入力してください。", true);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setRSSStatus("URL は http:// または https:// で始めてください。", true);
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
        setRSSStatus("追加に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("RSS フィードを追加しました。", false);
      if (rssAddInput) rssAddInput.value = "";
      loadRSSList();
    } catch (err) {
      setRSSStatus("エラーが発生しました: " + err.message, true);
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
        setRSSStatus("削除に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("RSS フィードを削除しました。", false);
      loadRSSList();
    } catch (err) {
      setRSSStatus("削除でエラーが発生しました: " + err.message, true);
    }
  }

  async function saveTitle(url, title) {
    try {
      const res = await fetch("/api/rss/title", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRSSStatus("フィード名の保存に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("フィード名を保存しました。", false);
    } catch (err) {
      setRSSStatus("保存でエラーが発生しました: " + err.message, true);
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
        setRSSStatus("プロンプトの保存に失敗しました: " + (result.error || res.status), true);
        return;
      }
      setRSSStatus("プロンプトを保存しました。", false);
    } catch (err) {
      setRSSStatus("保存でエラーが発生しました: " + err.message, true);
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
