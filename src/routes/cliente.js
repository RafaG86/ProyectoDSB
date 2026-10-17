const router = require('express').Router();
const db = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { calcular } = require('../lib/cotizacion');
const { analizar } = require('../lib/telefono');
const { enBogota, hoyBogota, recogidaMs } = require('../lib/tiempo');
const ajustes = require('../lib/ajustes');
const { avisar } = require('../lib/notificaciones');
const { nombreCompleto } = require('../lib/sql');

const ORIGEN = 'Bogotá'; // por ahora el servicio solo sale de Bogotá
const toursActivos = () => db.prepare('SELECT * FROM tours WHERE activo = 1').all();
const ACTIVAS = ['pendiente', 'confirmada'];
const MENSAJES_OK = ['creada', 'cancelada'];

const SELECT_RESERVA = `
  SELECT r.*, t.nombre AS tour_nombre, t.precio AS tour_precio, t.moneda AS tour_moneda, t.duracion_hrs,
         COALESCE(r.destino, t.destino) AS destino_final,
         ${nombreCompleto('e')} AS empleado, v.placa, v.tipo AS vehiculo_tipo
  FROM reservas r
  LEFT JOIN tours t ON t.id = r.tour_id
  LEFT JOIN usuarios e ON e.id = r.empleado_id
  LEFT JOIN vehiculos v ON v.id = r.vehiculo_id`;

function fechaValida(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(f + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && d.toLocaleDateString('en-CA') === f; // descarta 2026-02-31
}

// Para pedir una reserva la persona debe tener nombre, apellidos y un teléfono internacional válido.
function perfilCompleto(userId) {
  const u = db.prepare('SELECT nombre, apellidos, telefono FROM usuarios WHERE id = ?').get(userId);
  return !!(u && u.nombre && u.apellidos && analizar(u.telefono));
}
const exigirPerfil = (req, res, next) => (perfilCompleto(req.session.user.id) ? next() : res.redirect('/perfil?incompleto=1'));

// Devuelve { valores, error }. `valores` también sirve para rellenar el formulario de nuevo.
function validarReserva(body, t, divisas) {
  const texto = (x, max) => String(x ?? '').trim().slice(0, max);
  const v = {
    tipo: body.tipo === 'especial' ? 'especial' : 'tour',
    tour_id: null,
    fecha: texto(body.fecha, 10),
    hora: texto(body.hora, 5),
    punto_recogida: texto(body.punto_recogida, 201),
    destino: texto(body.destino, 201),
    pasajeros: Number(body.pasajeros),
    lleva_mascotas: body.lleva_mascotas === '1',
    mascotas_detalle: texto(body.mascotas_detalle, 500),
    lleva_ninos: body.lleva_ninos === '1',
    ninos_detalle: texto(body.ninos_detalle, 500),
    notas: texto(body.notas, 500),
    tourElegido: body.tour_id,
    moneda: String(body.moneda || ''),
  };
  const falla = (clave) => ({ valores: v, error: t(clave) });

  if (!divisas[v.moneda]) return falla('res.errCurrency');
  if (v.tipo === 'tour') {
    const tour = db.prepare('SELECT id FROM tours WHERE id = ? AND activo = 1').get(body.tour_id);
    if (!tour) return falla('cli.errTour');
    v.tour_id = tour.id;
    v.destino = '';
  } else if (!v.destino || v.destino.length > 200) {
    return falla('cli.errDest');
  }
  if (!fechaValida(v.fecha)) return falla('cli.errDate');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.hora)) return falla('cli.errTime');
  // Las reservas son para, como mínimo, N horas (24 por defecto) después de formalizar la cotización.
  const horas = ajustes.obtener('anticipacion_horas');
  if (recogidaMs(v.fecha, v.hora) < Date.now() + horas * 3600000) {
    return { valores: v, error: t('cli.errLead').replace('{horas}', horas) };
  }
  if (!v.punto_recogida || v.punto_recogida.length > 200) return falla('cli.errPickup');
  if (!Number.isInteger(v.pasajeros) || v.pasajeros < 1 || v.pasajeros > 60) return falla('cli.errPax');
  // Con mascotas o niños se exige describirlos: la empresa los usa para autorizar el transporte.
  if (v.lleva_mascotas && v.mascotas_detalle.length < 5) return falla('cli.errPets');
  if (v.lleva_ninos && v.ninos_detalle.length < 5) return falla('cli.errKids');
  if (!v.lleva_mascotas) v.mascotas_detalle = '';
  if (!v.lleva_ninos) v.ninos_detalle = '';
  return { valores: v, error: null };
}

const vistaReservar = (res, valores, error, status = 200) => {
  const horas = ajustes.obtener('anticipacion_horas');
  res.status(status).render('cliente/reservar', {
    tours: toursActivos(), valores, error, origen: ORIGEN,
    horas, hoy: enBogota(Date.now() + horas * 3600000).fecha, // primera fecha que cumple la anticipación
  });
};

// ---- Resumen ----
router.get('/', requirePermission('reservas.ver_propias'), (req, res) => {
  const reservas = db.prepare(SELECT_RESERVA + ' WHERE r.cliente_id = ? ORDER BY r.fecha DESC, r.hora DESC')
    .all(req.session.user.id);
  const h = hoyBogota();
  const resumen = {
    proximos: reservas.filter((r) => ACTIVAS.includes(r.estado) && r.fecha >= h).length,
    pendientes: reservas.filter((r) => r.estado === 'pendiente').length,
    completados: reservas.filter((r) => r.estado === 'completada').length,
  };
  res.render('cliente/dashboard', { reservas, resumen });
});

// ---- Pedir un servicio ----
router.get('/reservar', requirePermission('reservas.crear_propia'), exigirPerfil, (req, res) =>
  vistaReservar(res, { tipo: 'tour', pasajeros: 1 }, null));

router.post('/reservar', requirePermission('reservas.crear_propia'), exigirPerfil, (req, res) => {
  const { valores: v, error } = validarReserva(req.body, req.t, req.divisas);
  if (error) return vistaReservar(res, v, error, 400);
  const requiereAutorizacion = v.lleva_mascotas || v.lleva_ninos;
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO reservas (cliente_id, tipo, tour_id, origen, fecha, hora, punto_recogida, destino, pasajeros,
                          lleva_mascotas, mascotas_detalle, lleva_ninos, ninos_detalle, notas, moneda_solicitada, autorizacion)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.session.user.id, v.tipo, v.tour_id, ORIGEN, v.fecha, v.hora, v.punto_recogida,
    v.tipo === 'especial' ? v.destino : null, v.pasajeros,
    v.lleva_mascotas ? 1 : 0, v.mascotas_detalle || null, v.lleva_ninos ? 1 : 0, v.ninos_detalle || null,
    v.notas || null, v.moneda, requiereAutorizacion ? 'pendiente' : 'no_requiere');
  avisar('nueva_reserva', lastInsertRowid); // el equipo recibe el aviso (campana + celular) y empieza a revisarla
  res.redirect(`/cliente/reservas/${lastInsertRowid}?ok=creada`);
});

// ---- Detalle y cancelación (solo reservas propias) ----
router.get('/reservas/:id', requirePermission('reservas.ver_propias'), (req, res) => {
  const reserva = db.prepare(SELECT_RESERVA + ' WHERE r.id = ? AND r.cliente_id = ?').get(req.params.id, req.session.user.id);
  if (!reserva) return res.status(404).render('error', { titulo: req.t('err.404.title'), mensaje: req.t('err.404.msg') });
  const ok = MENSAJES_OK.includes(req.query.ok) ? req.t('cli.ok.' + req.query.ok) : null;
  const cot = reserva.total == null ? null
    : calcular({
      km: reserva.km, precio_km: reserva.precio_km, minimo: reserva.tarifa_minima, peajes: reserva.peajes, viaticos: reserva.viaticos,
      decimales: req.divisas[reserva.moneda || 'USD'].decimales,
    });
  res.render('cliente/reserva', { r: reserva, cot, ok, cancelable: ACTIVAS.includes(reserva.estado) && reserva.fecha >= hoyBogota() });
});

router.post('/reservas/:id/cancelar', requirePermission('reservas.cancelar_propia'), (req, res) => {
  const r = db.prepare('SELECT id, estado, fecha FROM reservas WHERE id = ? AND cliente_id = ?').get(req.params.id, req.session.user.id);
  if (!r) return res.redirect('/cliente');
  if (ACTIVAS.includes(r.estado) && r.fecha >= hoyBogota()) {
    db.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?").run(r.id);
    avisar('cancelada_cliente', r.id);
    return res.redirect(`/cliente/reservas/${r.id}?ok=cancelada`);
  }
  res.redirect(`/cliente/reservas/${r.id}`);
});

module.exports = router;
