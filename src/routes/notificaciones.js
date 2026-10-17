const express = require('express');
const db = require('../db/database');
const { requireLogin } = require('../middleware/auth');
const { avisar, clavePublica } = require('../lib/notificaciones');

// ---------- /notificaciones: la campana de la app ----------
const campana = express.Router();
campana.use(requireLogin);

const OK = ['prueba', 'leidas'];

campana.get('/', (req, res) => {
  const items = db.prepare('SELECT * FROM notificaciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 50').all(req.session.user.id);
  const dispositivos = db.prepare('SELECT COUNT(*) n FROM suscripciones_push WHERE usuario_id = ?').get(req.session.user.id).n;
  res.render('notificaciones', { items, dispositivos, ok: OK.includes(req.query.ok) ? req.t('notif.ok.' + req.query.ok) : null });
});

// La página la consulta cada 30 s para actualizar el número rojo de la campana.
campana.get('/contador', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ sinLeer: res.locals.sinLeer });
});

campana.post('/leer-todas', (req, res) => {
  db.prepare("UPDATE notificaciones SET leida_en = datetime('now') WHERE usuario_id = ? AND leida_en IS NULL").run(req.session.user.id);
  res.redirect('/notificaciones?ok=leidas');
});

campana.post('/prueba', (req, res) => {
  avisar('prueba', null, {}, [{ id: req.session.user.id, idioma: res.locals.lang }]);
  res.redirect('/notificaciones?ok=prueba');
});

// Marca como leída (solo si es suya) y lleva a la reserva.
campana.get('/:id/abrir', (req, res) => {
  const n = db.prepare('SELECT id, url FROM notificaciones WHERE id = ? AND usuario_id = ?').get(req.params.id, req.session.user.id);
  if (!n) return res.redirect('/notificaciones');
  db.prepare("UPDATE notificaciones SET leida_en = COALESCE(leida_en, datetime('now')) WHERE id = ?").run(n.id);
  res.redirect(n.url && n.url.startsWith('/') && !n.url.startsWith('//') ? n.url : '/notificaciones');
});

// ---------- /push: dispositivos que reciben notificaciones en el celular ----------
const push = express.Router();
push.use(requireLogin);

// El servidor solo envía a los servicios push de los navegadores conocidos. Si no, cualquiera podría registrar
// una dirección cualquiera y hacer que el servidor le envíe peticiones.
const SERVICIOS_PUSH = ['googleapis.com', 'mozilla.com', 'apple.com', 'windows.com'];
function endpointValido(texto) {
  try {
    const u = new URL(texto);
    return u.protocol === 'https:' && texto.length <= 600 && SERVICIOS_PUSH.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}
const MAX_DISPOSITIVOS = 10;

push.get('/clave', (req, res) => res.json({ publica: clavePublica() }));

push.post('/suscribir', (req, res) => {
  const { endpoint, keys } = req.body || {};
  const p256dh = keys && keys.p256dh, auth = keys && keys.auth;
  if (!endpointValido(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string'
    || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return res.status(400).json({ error: 'suscripcion_invalida' });
  }
  const uid = req.session.user.id;
  // El mismo dispositivo puede cambiar de dueño (otra persona inició sesión en él): se reasigna.
  db.prepare(`INSERT INTO suscripciones_push (usuario_id, endpoint, p256dh, auth, agente) VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, agente = excluded.agente`)
    .run(uid, endpoint, p256dh, auth, String(req.get('user-agent') || '').slice(0, 200));
  db.prepare(`DELETE FROM suscripciones_push WHERE usuario_id = ? AND id NOT IN
              (SELECT id FROM suscripciones_push WHERE usuario_id = ? ORDER BY id DESC LIMIT ?)`).run(uid, uid, MAX_DISPOSITIVOS);
  res.json({ ok: true });
});

push.post('/baja', (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  db.prepare('DELETE FROM suscripciones_push WHERE endpoint = ? AND usuario_id = ?').run(endpoint, req.session.user.id);
  res.json({ ok: true });
});

module.exports = { campana, push };
