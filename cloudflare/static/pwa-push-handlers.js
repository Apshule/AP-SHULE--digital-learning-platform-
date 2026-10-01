/* Additional push events shared by the generated Workbox Pages worker. */
const PAGES_CACHE_PREFIX = "apshule-cloudflare-shell-";
const PAGES_RELEASE_CACHE_PREFIX = `${PAGES_CACHE_PREFIX}v15-`;

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(PAGES_CACHE_PREFIX) && !key.startsWith(PAGES_RELEASE_CACHE_PREFIX))
      .map((key) => caches.delete(key)),
  )));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" ? payload.title : "APSHULE";
  const data = payload.data && typeof payload.data === "object" ? payload.data : { url: "/" };
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof payload.tag === "string" ? payload.tag : "apshule-notification",
    data,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = event.notification.data && typeof event.notification.data.url === "string"
    ? event.notification.data.url
    : "/";
  let target = new URL(requestedUrl, self.location.origin);
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const client = clients.find((candidate) => new URL(candidate.url).origin === self.location.origin);
    if (client && "focus" in client) {
      const focused = client.focus();
      if ("navigate" in client) return focused.then(() => client.navigate(target.href));
      return focused;
    }
    return self.clients.openWindow(target.href);
  }));
});