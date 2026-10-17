const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireLogin } = require('../middleware/auth');
const { analizar } = require('../lib/telefono');

router.use(requireLogin);

const OK = ['datos', 'password'];
const limpiar = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

const cargar = (id) => {
  const u = db.prepare('SELECT nombre, apellidos, email, telefono, pais, idioma FROM usuarios WHERE id = ?').get(id);
  const tel = analizar(u.telefono);
  return { ...u, apellidos: u.apellidos || '', telefono: tel ? tel.internacional : (u.telefono || '') };
};

const vista = (req, res, error = null, status = 200, valores = null) => res.status(status).render('perfil', {
  datos: valores || cargar(req.session.user.id),
  pais: valores ? null : cargar(req.session.user.id).pais,
  ok: OK.includes(req.query.ok) ? req.t('prof.ok.' + req.query.ok) : null,
  aviso: req.query.incompleto ? req.t('prof.completeToBook') : null,
  error,
});

router.get('/', (req, res) => vista(req, res));

router.post('/', (req, res) => {
  const v = { nombre: limpiar(req.body.nombre, 60), apellidos: limpiar(req.body.apellidos, 80), telefono: limpiar(req.body.telefono, 30) };
  const actual = cargar(req.session.user.id);
  const reenviar = (clave) => vista(req, res, req.t(clave), 400, { ...actual, ...v });
  if (!v.nombre || !v.apellidos) return reenviar('reg.errName');

  // Los clientes necesitan teléfono internacional válido; el resto del personal puede no tenerlo.
  const tel = v.telefono ? analizar(v.telefono) : null;
  if (v.telefono && !tel) return reenviar('reg.errPhone');
  if (!tel && res.locals.user.panel === 'cliente') return reenviar('reg.errPhone');

  db.prepare('UPDATE usuarios SET nombre = ?, apellidos = ?, telefono = ?, pais = ?, idioma = ? WHERE id = ?')
    .run(v.nombre, v.apellidos, tel ? tel.e164 : null, tel ? tel.pais : null, tel ? tel.idioma : null, req.session.user.id);
  res.redirect('/perfil?ok=datos');
});

router.post('/password', (req, res) => {
  const { actual, nueva, confirmar } = req.body;
  const fila = db.prepare('SELECT password_hash FROM usuarios WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(actual || '', fila.password_hash)) return vista(req, res, req.t('prof.errCurrent'), 400);
  if (!nueva || nueva.length < 8 || nueva !== confirmar) return vista(req, res, req.t('prof.errNew'), 400);
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nueva, 10), req.session.user.id);
  res.redirect('/perfil?ok=password');
});

module.exports = router;
