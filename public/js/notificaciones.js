// Notificaciones de DSB: registra el service worker, mantiene al día el número de la campana
// y, en la página /notificaciones, permite activar o desactivar los avisos en este dispositivo.
(function () {
  'use strict';

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  // ---- Número de avisos sin leer (también en el ícono de la app instalada) ----
  var badge = document.getElementById('notif-badge');
  function pintar(n) {
    if (badge) { badge.textContent = n; badge.hidden = !n; }
    try { if (n && navigator.setAppBadge) navigator.setAppBadge(n); else if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {}
  }
  function refrescar() {
    fetch('/notificaciones/contador', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) pintar(j.sinLeer); })
      .catch(function () {});
  }
  setInterval(refrescar, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refrescar(); });

  // ---- Activar avisos en este dispositivo (solo existe en /notificaciones) ----
  var panel = document.getElementById('push-panel');
  if (!panel) return;
  var estado = document.getElementById('push-estado');
  var boton = document.getElementById('push-boton');
  var baja = document.getElementById('push-baja');
  var msg = function (k) { return panel.getAttribute('data-' + k); };
  function mostrar(texto, clase) { estado.textContent = texto; estado.className = clase || 'muted'; }

  function clave(b64) { // la clave pública llega en base64url y el navegador la pide como bytes
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, function (c) { return c.charCodeAt(0); });
  }
  function enviar(url, cuerpo) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  }
  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function inicio() {
    if (!window.isSecureContext) { boton.hidden = true; return mostrar(msg('insecure'), 'error'); }
    if (esIOS && !instalada) { boton.hidden = true; return mostrar(msg('ios'), 'error'); }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      boton.hidden = true; return mostrar(msg('unsupported'), 'error');
    }
    if (Notification.permission === 'denied') { boton.hidden = true; return mostrar(msg('denied'), 'error'); }
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      boton.hidden = !!sub; baja.hidden = !sub;
      mostrar(sub ? msg('on') : msg('off'), sub ? 'ok' : 'muted');
    }).catch(function () { mostrar(msg('unsupported'), 'error'); });
  }

  boton.addEventListener('click', function () {
    boton.disabled = true;
    Notification.requestPermission().then(function (permiso) {
      if (permiso !== 'granted') { mostrar(msg('denied'), 'error'); boton.hidden = true; return null; }
      return Promise.all([navigator.serviceWorker.ready, fetch('/push/clave', { credentials: 'same-origin' }).then(function (r) { return r.json(); })])
        .then(function (x) {
          return x[0].pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: clave(x[1].publica) });
        })
        .then(function (sub) { return enviar('/push/suscribir', sub.toJSON()); })
        .then(function (r) { if (!r.ok) throw new Error('registro'); inicio(); });
    }).catch(function () { mostrar(msg('error'), 'error'); }).then(function () { boton.disabled = false; });
  });

  baja.addEventListener('click', function () {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) return null;
      return enviar('/push/baja', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
    }).then(inicio).catch(function () { mostrar(msg('error'), 'error'); });
  });

  inicio();
})();
