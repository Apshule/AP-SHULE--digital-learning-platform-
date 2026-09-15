/* Root worker for the offline shell. Firebase push remains in its existing worker. */
importScripts('/firebase-messaging-sw.js');

var APP_VERSION = 'appshule-offline-v3';
var SHELL_CACHE = APP_VERSION + '-shell';
var STORAGE_CACHE = APP_VERSION + '-firebase-storage';
var DATA_CACHE = APP_VERSION + '-data';
var LIMITS = { shell: 5 * 1024 * 1024, storage: 10 * 1024 * 1024, data: 2 * 1024 * 1024 };
var STORAGE_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com', 'appshule-app.firebasestorage.app'];
var BLOCKED_HOST = /(^|\.)((youtube\.com)|(youtu\.be)|(youtube-nocookie\.com)|(googlevideo\.com))$/i;
var FIRESTORE_HOST = 'firestore.googleapis.com';
var STATIC_CDN_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'i.ibb.co'];
var SHELL_ASSETS = ['/', '/index.html', '/offline-manager.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512-maskable.png'];

function isFirebaseStorageUrl(url) {
  return STORAGE_HOSTS.indexOf(url.hostname.toLowerCase()) >= 0 && !BLOCKED_HOST.test(url.hostname);
}

function isFirestoreRead(request, url) {
  return request.method === 'GET' && url.hostname.toLowerCase() === FIRESTORE_HOST &&
    (/\/v1\/projects\/[^/]+\/databases\//.test(url.pathname) || /\/google\.firestore\.v1\.Firestore\//.test(url.pathname));
}

function isShellRequest(request, url) {
  if (request.method !== 'GET') return false;
  var allowedOrigin = url.origin === self.location.origin || STATIC_CDN_HOSTS.indexOf(url.hostname.toLowerCase()) >= 0;
  return allowedOrigin && (request.mode === 'navigate' || /\.(?:html?|css|js|mjs|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname));
}

function responseBytes(response) {
  var length = response.headers.get('content-length');
  if (length) return Promise.resolve(Number(length));
  return response.clone().blob().then(function (blob) { return blob.size; }).catch(function () { return 0; });
}

function trimCache(cacheName, byteLimit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      var total = 0;
      return Promise.all(keys.map(function (request) {
        return cache.match(request).then(function (response) {
          return (response ? responseBytes(response) : Promise.resolve(0)).then(function (bytes) {
            total += bytes;
            return { request: request, bytes: bytes };
          });
        });
      })).then(function (entries) {
        var removals = [];
        entries.forEach(function (entry) {
          if (total > byteLimit) {
            total -= entry.bytes;
            removals.push(cache.delete(entry.request));
          }
        });
        /* Content-Length is optional; entry count still prevents unbounded growth. */
        if (keys.length - removals.length > 120) {
          keys.slice(0, keys.length - removals.length - 120).forEach(function (request) { removals.push(cache.delete(request)); });
        }
        return Promise.all(removals);
      });
    });
  });
}

function cacheResponse(cacheName, request, response, byteLimit) {
  if (!response || (!response.ok && response.type !== 'opaque')) return Promise.resolve(response);
  return caches.open(cacheName).then(function (cache) {
    return cache.put(request, response.clone()).then(function () {
      return trimCache(cacheName, byteLimit);
    }).then(function () { return response; });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) { return cacheResponse(SHELL_CACHE, request, response, LIMITS.shell); });
  });
}

function networkFirst(request, cacheName, byteLimit) {
  return fetch(request).then(function (response) {
    return cacheResponse(cacheName, request, response, byteLimit);
  }).catch(function () { return caches.match(request).then(function (cached) { return cached || Response.error(); }); });
}

function storageStaleWhileRevalidate(request, event) {
  return caches.match(request).then(function (cached) {
    var update = fetch(request).then(function (response) {
      return cacheResponse(STORAGE_CACHE, request, response, LIMITS.storage);
    }).catch(function () { return null; });
    if (event && event.waitUntil) event.waitUntil(update);
    return cached || update.then(function (response) { return response || Response.error(); });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL_CACHE).then(function (cache) {
    return Promise.all(SHELL_ASSETS.map(function (asset) {
      return fetch(asset).then(function (response) {
        return response.ok ? cache.put(asset, response) : null;
      }).catch(function () { return null; });
    }));
  }).then(function () { return trimCache(SHELL_CACHE, LIMITS.shell); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key.indexOf('appshule-offline-') === 0 && key.indexOf(APP_VERSION) !== 0;
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);
  if (BLOCKED_HOST.test(url.hostname)) return;
  if (request.method === 'GET' && isFirebaseStorageUrl(url)) {
    event.respondWith(storageStaleWhileRevalidate(request, event));
    return;
  }
  if (isFirestoreRead(request, url)) {
    event.respondWith(networkFirst(request, DATA_CACHE, LIMITS.data));
    return;
  }
  if (isShellRequest(request, url)) {
    event.respondWith(request.mode === 'navigate'
      ? networkFirst(request, SHELL_CACHE, LIMITS.shell)
      : cacheFirst(request));
  }
});