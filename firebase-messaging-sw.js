importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ── Web Push (VAPID) handler ──────────────────────────────────────────────────
// Fires for push messages sent by the API server via web-push (non-FCM path).
// Runs even when the browser tab is closed.
self.addEventListener('push', function (event) {
  if (!event.data) return;

  var data;
  try {
    data = event.data.json();
  } catch (_) {
    data = { title: 'APSHULE', body: event.data.text() };
  }

  // Skip if no title — FCM data-only payloads are handled by onBackgroundMessage below
  if (!data.title) return;

  // Avoid double-firing if this is also an FCM message
  if (data._fcm) return;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: 'apshule-push',
      renotify: true,
      data: data
    })
  );
});

// ── Firebase Cloud Messaging (FCM) handler ────────────────────────────────────
firebase.initializeApp({
    apiKey: "AIzaSyBaO3Al6ubOcH3NxZBYmhjuOyihYc_q9kg",
    authDomain: "apshule-app.firebaseapp.com",
    projectId: "apshule-app",
    storageBucket: "apshule-app.firebasestorage.app",
    messagingSenderId: "610368652834",
    appId: "1:610368652834:web:1a30274d95c282a5a3ac7b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  var notification = payload.notification || {};
  var data = payload.data || {};
  var title = notification.title || data.title || 'APSHULE';
  var body  = notification.body  || data.body  || '';

  return self.registration.showNotification(title, {
    body: body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'apshule-fcm-' + Date.now(),
    renotify: true,
    data: data
  });
});
