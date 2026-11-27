self.addEventListener('push', (event) => {
  if (!event.data) return;
  const message = event.data.json();
  event.waitUntil(
    self.registration.showNotification(message.title || 'Assist', {
      body: message.body || 'Заплановане нагадування',
      icon: '/assist.svg',
      tag: message.tag,
      data: { url: message.url || '/' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
