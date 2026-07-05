// Service Worker for Web Push notifications

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text() };
  }

  const title = payload.title || "News Alert";
  const url = payload.url || "/";

  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icons/news-192.png",
    badge: payload.badge || "/icons/badge-72.png",
    tag: payload.tag || "news-alert",
    data: { url },
  };

  // Add an "Open article" action button where supported (e.g. Android Chrome).
  // Browsers that don't support actions will silently ignore this field.
  if (url && url !== "/") {
    options.actions = [
      { action: "open_url", title: "記事を開く" },
    ];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Both action button click and direct notification tap open the target URL.
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus existing tab if already open
        for (const client of windowClients) {
          if (client.url === url && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open a new tab
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});
