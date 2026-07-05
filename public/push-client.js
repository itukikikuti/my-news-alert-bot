/* push-client.js – Browser-side Web Push subscription logic */
(function () {
  "use strict";

  // VAPID_PUBLIC_KEY is injected by the server as a global variable.
  // See server.js: window.VAPID_PUBLIC_KEY = "..."
  const vapidPublicKey = window.VAPID_PUBLIC_KEY;

  const statusEl = document.getElementById("push-status");
  const subscribeBtn = document.getElementById("push-subscribe-btn");
  const sendTestBtn = document.getElementById("push-send-test-btn");
  const pushTestTitleEl = document.getElementById("push-test-title");
  const pushTestBodyEl = document.getElementById("push-test-body");
  const pushTestUrlEl = document.getElementById("push-test-url");
  const pushTestStatusEl = document.getElementById("push-test-status");
  const subListContainer = document.getElementById("sub-list-container");
  const subListStatusEl = document.getElementById("sub-list-status");
  const subReloadBtn = document.getElementById("sub-reload-btn");

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "feedback " + (isError ? "error" : "success");
    statusEl.style.display = "block";
  }

  function setPushTestStatus(msg, isError) {
    if (!pushTestStatusEl) return;
    pushTestStatusEl.textContent = msg;
    pushTestStatusEl.className = "feedback " + (isError ? "error" : "success");
    pushTestStatusEl.style.display = "block";
  }

  function setSubListStatus(msg, isError) {
    if (!subListStatusEl) return;
    subListStatusEl.textContent = msg;
    subListStatusEl.className = "feedback " + (isError ? "error" : "success");
    subListStatusEl.style.display = "block";
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function subscribeToPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("❌ このブラウザはWeb Pushに対応していません。", true);
      return;
    }

    if (!vapidPublicKey) {
      setStatus("❌ VAPIDキーが設定されていません。サーバーの設定を確認してください。", true);
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("❌ 通知の許可が拒否されました。ブラウザの設定から許可してください。", true);
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setStatus("❌ 購読の保存に失敗しました: " + (err.error || res.status), true);
        return;
      }

      setStatus("✅ Push通知の購読が完了しました！", false);
      if (subscribeBtn) {
        subscribeBtn.textContent = "購読済み ✅";
        subscribeBtn.dataset.subscribed = "true";
      }
      loadSubscriptionList();
    } catch (err) {
      setStatus("❌ エラーが発生しました: " + err.message, true);
    }
  }

  async function unsubscribeFromPush() {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        setStatus("未購読状態です。", false);
        return;
      }
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setStatus("未購読状態です。", false);
        return;
      }

      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      await subscription.unsubscribe();
      setStatus("✅ Push通知の購読を解除しました。", false);
      if (subscribeBtn) {
        subscribeBtn.textContent = "Push通知を購読する";
        subscribeBtn.dataset.subscribed = "";
      }
      loadSubscriptionList();
    } catch (err) {
      setStatus("❌ 解除に失敗しました: " + err.message, true);
    }
  }

  async function sendTestPush() {
    if (!vapidPublicKey) {
      setPushTestStatus("❌ VAPIDキーが設定されていないため、Web Push を送信できません。", true);
      return;
    }

    const title = (pushTestTitleEl?.value || "テスト通知").trim().slice(0, 200) || "テスト通知";
    const body = (pushTestBodyEl?.value || "").trim().slice(0, 500);
    const rawUrl = (pushTestUrlEl?.value || "").trim().slice(0, 2000);

    // Light URL validation: accept empty or valid http(s) URLs
    if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
      setPushTestStatus("❌ URLは http:// または https:// で始めてください。", true);
      return;
    }

    try {
      const payload = { title, body };
      if (rawUrl) payload.url = rawUrl;

      const res = await fetch("/api/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPushTestStatus("❌ Web Push のテスト送信に失敗しました: " + (result.error || res.status), true);
        return;
      }

      const hasCounts =
        typeof result.sent === "number" &&
        typeof result.failed === "number" &&
        typeof result.removed === "number";

      if (!hasCounts) {
        setPushTestStatus("✅ Web Push のテスト送信リクエストを受け付けました。", false);
        return;
      }

      if (result.sent === 0 && result.failed === 0 && result.removed === 0) {
        setPushTestStatus("❌ 送信先の Push 購読がありません。先に「Push通知を購読する」を実行してください。", true);
        return;
      }

      if (result.sent > 0) {
        setPushTestStatus(`✅ Web Push をテスト送信しました（成功: ${result.sent}件 / 失敗: ${result.failed}件 / 削除: ${result.removed}件）`, false);
        return;
      }

      setPushTestStatus(`❌ Web Push のテスト送信に失敗しました（失敗: ${result.failed}件 / 削除: ${result.removed}件）`, true);
    } catch (err) {
      setPushTestStatus("❌ Web Push のテスト送信でエラーが発生しました: " + err.message, true);
    }
  }

  async function removeSubscriptionByEndpoint(endpoint) {
    try {
      const res = await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSubListStatus("❌ 削除に失敗しました: " + (err.error || res.status), true);
        return;
      }
      setSubListStatus("✅ 購読を削除しました。", false);
      loadSubscriptionList();
    } catch (err) {
      setSubListStatus("❌ 削除でエラーが発生しました: " + err.message, true);
    }
  }

  async function loadSubscriptionList() {
    if (!subListContainer) return;
    try {
      const res = await fetch("/api/push/subscriptions");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const list = await res.json();

      if (!Array.isArray(list) || list.length === 0) {
        subListContainer.innerHTML = '<p class="empty">購読はありません。</p>';
        return;
      }

      const tableRows = list
        .map((sub, i) => {
          const ep = sub.endpoint || "";
          const short = ep.length > 64 ? ep.slice(0, 32) + "…" + ep.slice(-20) : ep;
          return `<tr>
            <td>${i + 1}</td>
            <td><code title="${ep}">${short}</code></td>
            <td><button class="danger" data-endpoint="${ep}" onclick="window.__removeSubscription(this.dataset.endpoint)">削除</button></td>
          </tr>`;
        })
        .join("");

      subListContainer.innerHTML = `<table id="sub-table">
        <thead><tr><th>#</th><th>エンドポイント</th><th>操作</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
    } catch (err) {
      subListContainer.innerHTML = `<p class="empty">読み込みに失敗しました: ${err.message}</p>`;
    }
  }

  // Expose remove handler for inline onclick
  window.__removeSubscription = removeSubscriptionByEndpoint;

  async function checkSubscriptionState() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription && subscribeBtn) {
        subscribeBtn.textContent = "購読済み ✅";
        subscribeBtn.dataset.subscribed = "true";
      }
    } catch {
      // ignore
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    checkSubscriptionState();
    loadSubscriptionList();

    if (subscribeBtn) {
      subscribeBtn.addEventListener("click", () => {
        if (subscribeBtn.dataset.subscribed === "true") {
          unsubscribeFromPush();
          subscribeBtn.dataset.subscribed = "";
        } else {
          subscribeToPush();
        }
      });
    }

    if (sendTestBtn) {
      sendTestBtn.addEventListener("click", () => {
        sendTestPush();
      });
    }

    if (subReloadBtn) {
      subReloadBtn.addEventListener("click", () => {
        loadSubscriptionList();
      });
    }
  });
})();
