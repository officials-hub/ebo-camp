/* EBO Camp service worker
 * Receives Web Push events and shows a notification.
 * Tapping the notification focuses (or opens) the portal.
 */

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'EBO Camp', body: event.data ? event.data.text() : '' };
  }

  // Resolve icons + the click-through URL relative to the SW scope so they
  // work whether the app is hosted at /ebo-camp/ on GitHub Pages or at the
  // root on Netlify. An absolute "/" in the payload would otherwise dump
  // users at the GitHub Pages org apex (404).
  const scope = self.registration.scope;
  const resolve = (val, fallback) => {
    if (!val) return new URL(fallback, scope).href;
    try { return new URL(val, scope).href; } catch (e) { return new URL(fallback, scope).href; }
  };

  const title = data.title || 'EBO Camp';
  const options = {
    body: data.body || '',
    icon: resolve(data.icon, 'icon-192.png'),
    badge: resolve(data.badge, 'icon-192.png'),
    tag: data.tag || 'ebo-camp',
    renotify: true,
    data: { url: resolve(data.url, '') },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  const targetUrl = (event.notification.data && event.notification.data.url) || scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an EBO tab that's already open under our scope. Match by scope
      // prefix so we don't grab an unrelated tab on the same origin.
      for (const w of wins) {
        if (w.url && w.url.indexOf(scope) === 0 && 'focus' in w) {
          if ('navigate' in w && w.url !== targetUrl) {
            return w.navigate(targetUrl).then(() => w.focus()).catch(() => w.focus());
          }
          return w.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
