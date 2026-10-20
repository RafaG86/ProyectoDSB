const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { HOME } = require('../db/permisos');
const { analizar } = require('../lib/telefono');
const { recordarIdioma } = require('../i18n');
const { rutaSegura } = require('../lib/contacto');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const limpiar = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// `next` = a dónde seguir después de ingresar (solo rutas internas).
const siguiente = (req) => rutaSegura((req.body && req.body.next) || req.query.next);

router.get('/login', (req, res) => {
  if (req.session.user && res.locals.user) return res.redirect(siguiente(req) || HOME[res.locals.user.panel]);
  res.render('login', { error: null, ok: req.query.ok === 'registro' ? req.t('login.registered') : null, next: siguiente(req) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT u.*, r.panel FROM usuarios u JOIN roles r ON r.clave = u.rol WHERE u.email = ? AND u.activo = 1').get((email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.status(401).render('login', { error: req.t('login.error'), ok: null, next: siguiente(req) });
  }
  recordarIdioma(req, res, u.idioma); // si la persona no ha elegido idioma, se usa el de su país
  req.session.regenerate(() => {
    req.session.user = { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, panel: u.panel };
    res.redirect(siguiente(req) || HOME[u.panel]);
  });
});

const vistaRegistro = (res, error, valores = {}, status = 200, next = '') => res.status(status).render('registro', { error, v: valores, next });

router.get('/registro', (req, res) => vistaRegistro(res, null, {}, 200, siguiente(req)));

// El registro público siempre crea clientes. Empleados y admins los crea un admin.
// Para pedir una reserva hace falta estar registrado con nombre, apellidos, correo y teléfono internacional.
router.post('/registro', (req, res) => {
  const v = {
    nombre: limpiar(req.body.nombre, 60), apellidos: limpiar(req.body.apellidos, 80),
    email: limpiar(req.body.email, 254).toLowerCase(), telefono: limpiar(req.body.telefono, 30),
  };
  const password = String(req.body.password ?? '');
  const tel = analizar(v.telefono);
  const next = siguiente(req);
  if (!v.nombre || !v.apellidos) return vistaRegistro(res, req.t('reg.errName'), v, 400, next);
  if (!EMAIL.test(v.email)) return vistaRegistro(res, req.t('reg.errEmail'), v, 400, next);
  if (!tel) return vistaRegistro(res, req.t('reg.errPhone'), v, 400, next);
  if (password.length < 8) return vistaRegistro(res, req.t('reg.errPassword'), v, 400, next);
  try {
    db.prepare('INSERT INTO usuarios (nombre, apellidos, email, telefono, pais, idioma, password_hash, rol) VALUES (?,?,?,?,?,?,?,?)')
      .run(v.nombre, v.apellidos, v.email, tel.e164, tel.pais, tel.idioma, bcrypt.hashSync(password, 10), 'cliente');
  } catch (e) {
    return vistaRegistro(res, req.t('reg.errExists'), v, 400, next);
  }
  recordarIdioma(req, res, tel.idioma);
  res.redirect('/login?ok=registro' + (next ? '&next=' + encodeURIComponent(next) : ''));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
