// Service worker de DSB: recibe las notificaciones push aunque la app esté cerrada y abre la reserva al tocarlas.
// Importante: solo funciona en HTTPS (o en localhost). En iPhone, además, la app debe estar instalada en la pantalla de inicio.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: 'DSB Transportes', cuerpo: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'DSB Transportes', {
    body: d.cuerpo || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: d.tag || undefined,            // los avisos de una misma reserva se reemplazan entre sí
    renotify: !!d.tag,                  // pero el nuevo vuelve a sonar/vibrar
    requireInteraction: !!d.urgente,    // los urgentes no desaparecen solos
    vibrate: d.urgente ? [200, 100, 200, 100, 200] : [100],
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
    for (const v of ventanas) {
      if (new URL(v.url).origin === self.location.origin && 'focus' in v) {
        return v.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : null));
      }
    }
    return self.clients.openWindow(url);
  }));
});

// Necesario para que los navegadores consideren instalable la app; no intercepta nada.
self.addEventListener('fetch', () => {});
