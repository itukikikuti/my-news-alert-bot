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

      // Render one card per feed. Cards keep long URLs and the prompt editor
      // readable on a phone, where a four-column table collapses badly.
      const cards = list.map((feed, i) => {
        const url = typeof feed === "string" ? feed : feed.url;
        const prompt = typeof feed === "string" ? "" : feed.prompt || "";
        const title = typeof feed === "string" ? "" : feed.title || "";

        const card = document.createElement("div");
        card.className =
          "rounded-lg border border-slate-200 bg-slate-50/60 p-4";

        // Card head: number + editable feed name + delete.
        const head = document.createElement("div");
        head.className = "flex items-start gap-3";

        const badge = document.createElement("span");
        badge.className =
          "mt-1 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600";
        badge.textContent = String(i + 1);

        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.maxLength = 200;
        titleInput.placeholder = "フィード名（表示用）";
        titleInput.value = title;
        titleInput.className =
          "min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-semibold outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
        titleInput.addEventListener("blur", () => saveTitle(url, titleInput.value));
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            titleInput.blur();
          }
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "削除";
        delBtn.className =
          "flex-none whitespace-nowrap rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50";
        delBtn.addEventListener("click", () => deleteRSSUrl(url));

        head.appendChild(badge);
        head.appendChild(titleInput);
        head.appendChild(delBtn);
        card.appendChild(head);

        // URL stays visible: it identifies the feed at a glance.
        const urlValue = document.createElement("div");
        urlValue.className =
          "mt-2 pl-9 text-xs text-slate-400 [overflow-wrap:anywhere]";
        urlValue.textContent = url;
        card.appendChild(urlValue);

        // Prompt editor: label + textarea + save.
        const label = document.createElement("label");
        label.className = "mt-3 block pl-9 text-xs font-medium text-slate-600";
        label.textContent = "通知プロンプト（任意）";
        card.appendChild(label);

        const textarea = document.createElement("textarea");
        textarea.rows = 3;
        textarea.maxLength = 2000;
        textarea.placeholder = "空欄なら全て通知。書くとAIが絞り込みます。";
        textarea.value = prompt;
        textarea.className =
          "mt-2 ml-9 w-[calc(100%-2.25rem)] rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
        card.appendChild(textarea);

        const actions = document.createElement("div");
        actions.className = "mt-2 flex justify-end pl-9";
        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "保存";
        saveBtn.className =
          "whitespace-nowrap rounded-md bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50";
        saveBtn.addEventListener("click", () => savePrompt(url, textarea.value, saveBtn));
        actions.appendChild(saveBtn);
        card.appendChild(actions);

        return card;
      });

      rssListContainer.replaceChildren(...cards);
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
