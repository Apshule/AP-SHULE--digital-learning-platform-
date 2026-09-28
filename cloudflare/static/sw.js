const CACHE_NAME = "apshule-cloudflare-shell-v6";
const APP_SHELL = ["/", "/clinic/", "/farm/", "/mfi/", "/app.css", "/reset-password.html", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512-maskable.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("apshule-cloudflare-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/reset-password.html" && url.searchParams.has("token")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && !response.headers.has("set-cookie")) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request) || await cache.match(url.pathname);
      return cached || (request.mode === "navigate" ? await cache.match("/") : Response.error());
    }
  })());
});