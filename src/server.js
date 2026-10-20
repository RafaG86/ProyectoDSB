const path = require('path');
const express = require('express');
const session = require('express-session');
const i18n = require('./i18n');
const { cargarAcceso } = require('./middleware/auth');
const divisas = require('./middleware/divisas');
const tiempo = require('./middleware/tiempo');
const { campana, push } = require('./routes/notificaciones');
const { revisarAlertas } = require('./lib/notificaciones');
require('./db/database'); // inicializa el esquema

const app = express();
const PORT = process.env.PORT || 3000;

// Detrás de un proxy (Nginx, un hosting, un túnel) la IP real del visitante viene en una cabecera. TRUST_PROXY=1 le dice a la
// app que confíe en ella; sin eso, el límite anti-spam del formulario vería a todos los visitantes como una sola persona.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '16kb' })); // suscripciones push (el navegador las envía como JSON)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  // El service worker nunca debe quedar en caché, o las correcciones tardarían en llegar a los celulares.
  setHeaders: (res, archivo) => { if (archivo.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); },
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-cambiar',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));

app.use(i18n.middleware);
app.use(cargarAcceso); // deja `user` y `can()` disponibles en rutas y vistas
app.use(i18n.router);
app.use(divisas.middleware);
app.use(divisas.router);
app.use(tiempo.middleware);

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/empleado', require('./routes/empleado'));
app.use('/cliente', require('./routes/cliente'));
app.use('/perfil', require('./routes/perfil'));
app.use('/notificaciones', campana);
app.use('/push', push);

app.use((req, res) => {
  res.status(404).render('error', { titulo: req.t('err.404.title'), mensaje: req.t('err.404.msg') });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { titulo: req.t('err.500.title'), mensaje: req.t('err.500.msg') });
});

app.listen(PORT, () => console.log(`DSB en http://localhost:${PORT}`));

// Cada minuto: avisa de solicitudes sin responder a tiempo y de plazos para confirmar que se acaban.
// (ALERTAS_AUTO=0 lo desactiva; las pruebas llaman a revisarAlertas() a mano.)
if (process.env.ALERTAS_AUTO !== '0') {
  const revisar = () => { try { revisarAlertas(); } catch (e) { console.error('Alertas:', e); } };
  setTimeout(revisar, 5000);
  setInterval(revisar, 60 * 1000);
}
