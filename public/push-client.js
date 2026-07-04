/* push-client.js – Browser-side Web Push subscription logic */
(function () {
  "use strict";

  // VAPID_PUBLIC_KEY is injected by the server as a global variable.
  // See server.js: window.VAPID_PUBLIC_KEY = "..."
  const vapidPublicKey = window.VAPID_PUBLIC_KEY;

  const statusEl = document.getElementById("push-status");
  const subscribeBtn = document.getElementById("push-subscribe-btn");

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "feedback " + (isError ? "error" : "success");
    statusEl.style.display = "block";
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
      if (subscribeBtn) subscribeBtn.textContent = "購読済み ✅";
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
      if (subscribeBtn) subscribeBtn.textContent = "Push通知を購読する";
    } catch (err) {
      setStatus("❌ 解除に失敗しました: " + err.message, true);
    }
  }

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
  });
})();
