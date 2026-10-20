const router = require('express').Router();
const db = require('../db/database');
const ajustes = require('../lib/ajustes');
const { analizar } = require('../lib/telefono');
const { avisar } = require('../lib/notificaciones');
const { datosPublicos } = require('../lib/contacto');
const { enBogota } = require('../lib/tiempo');

const TIPOS = ['turismo', 'traslado', 'empresa'];

// Límite sencillo contra el spam del formulario: 5 envíos por hora desde la misma IP.
const intentos = new Map();
const MAX_INTENTOS = 5, VENTANA_MS = 3600000;
function registrarIntento(ip) {
  const ahora = Date.now();
  if (intentos.size > 2000) for (const [k, v] of intentos) if (!v.some((t) => ahora - t < VENTANA_MS)) intentos.delete(k);
  const lista = (intentos.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  const bloqueado = lista.length >= MAX_INTENTOS;
  lista.push(ahora);
  intentos.set(ip, lista);
  return bloqueado;
}

function vistaLanding(req, res, { error = null, ok = false, valores = {}, status = 200 } = {}) {
  const horas = ajustes.obtener('anticipacion_horas');
  res.status(status).render('landing', {
    tours: db.prepare('SELECT * FROM tours WHERE activo = 1').all(),
    horas, minFecha: enBogota(Date.now() + horas * 3600000).fecha,
    pub: datosPublicos(), error, ok, valores,
    tipoPre: TIPOS.includes(valores.tipo) ? valores.tipo : (TIPOS.includes(req.query.tipo) ? req.query.tipo : 'turismo'),
  });
}

router.get('/', (req, res) => vistaLanding(req, res, { ok: req.query.contacto === 'ok' }));

// Botón "Ver precio y reservar" del buscador de la portada: lleva al formulario de reserva con lo elegido ya escrito.
router.get('/reservar', (req, res) => {
  const servicio = String(req.query.servicio ?? '');
  if (servicio === 'empresa') return res.redirect('/?tipo=empresa#cotizar');
  const tour = /^tour:(\d+)$/.exec(servicio);
  const params = new URLSearchParams();
  if (tour) {
    if (!db.prepare('SELECT 1 FROM tours WHERE id = ? AND activo = 1').get(tour[1])) return res.redirect('/#tours');
    params.set('tipo', 'tour'); params.set('tour_id', tour[1]);
  } else if (servicio === 'traslado') params.set('tipo', 'especial');
  else return res.redirect('/');
  const pax = Number(req.query.pax);
  if (Number.isInteger(pax) && pax >= 1 && pax <= 60) params.set('pasajeros', String(pax));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha))) params.set('fecha', String(req.query.fecha));
  const destino = '/cliente/reservar?' + params.toString();
  if (res.locals.user) return res.redirect(res.locals.can('reservas.crear_propia') ? destino : '/');
  res.redirect('/registro?next=' + encodeURIComponent(destino));
});

// Formulario corto de cotización para quien aún no tiene cuenta.
router.post('/contacto', (req, res) => {
  if (req.body.web) return res.redirect('/?contacto=ok#cotizar'); // campo trampa que solo llenan los robots: se les finge éxito
  const valores = {
    nombre: String(req.body.nombre ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
    contacto: String(req.body.contacto ?? '').trim().slice(0, 30),
    tipo: String(req.body.tipo ?? ''), mensaje: String(req.body.mensaje ?? '').trim().replace(/\s+/g, ' ').slice(0, 300),
  };
  const falla = (clave, status = 400) => vistaLanding(req, res, { error: req.t(clave), valores, status });
  if (registrarIntento(req.ip)) return falla('land.form.err.rate', 429);
  if (valores.nombre.length < 2) return falla('land.form.err.name');
  const tel = analizar(valores.contacto, 'CO');
  if (!tel) return falla('land.form.err.contact');
  if (!TIPOS.includes(valores.tipo)) return falla('land.form.err.type');

  const { lastInsertRowid } = db.prepare('INSERT INTO contactos (nombre, contacto, tipo, mensaje, idioma) VALUES (?,?,?,?,?)')
    .run(valores.nombre, tel.e164, valores.tipo, valores.mensaje || null, res.locals.lang);
  avisar('contacto_nuevo', null, { nombre: valores.nombre, contacto: tel.internacional, tipoContacto: valores.tipo, url: '/admin/contactos?estado=nuevo' });
  res.redirect('/?contacto=ok#cotizar');
});

module.exports = router;
