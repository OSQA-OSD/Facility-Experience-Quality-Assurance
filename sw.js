/* OSQA service worker — only for notifications. It caches nothing, so the app is always the
 * latest version from the server.
 *
 * A notification arrives encrypted from the push service; the browser decrypts it and hands it
 * here. It is shown on the lock screen / in the notification centre, the app icon shows the
 * unread count, and tapping it opens the app on the right page. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'OSQA', body: event.data ? event.data.text() : '' }; }
  const work = [self.registration.showNotification(d.title || 'OSQA', {
    body: d.body || '',
    icon: '/osqa-icon-180.png',
    badge: '/osqa-icon-180.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/app' },
  })];
  if (self.navigator.setAppBadge) {
    work.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find((c) => new URL(c.url).pathname.startsWith('/app'));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
