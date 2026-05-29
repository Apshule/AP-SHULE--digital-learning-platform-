importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyBaO3Al6ubOcH3NxZBYmhjuOyihYc_q9kg",
    authDomain: "apshule-app.firebaseapp.com",
    projectId: "apshule-app",
    storageBucket: "apshule-app.firebasestorage.app",
    messagingSenderId: "610368652834",
    appId: "1:610368652834:web:1a30274d95c282a5a3ac7b"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
    self.registration.showNotification(payload.notification.title, {
        body: payload.notification.body,
        icon: '/favicon.ico'
    });
});
