const router = require('express').Router();
const db = require('../db/database');
const { nombreCompleto } = require('../lib/sql');
const { requirePermission } = require('../middleware/auth');
const { avisar } = require('../lib/notificaciones');
const { serviciosEnRango } = require('../lib/disponibilidad');
const { hoyBogota } = require('../lib/tiempo');

const verServicios = requirePermission('servicios.ver_asignados');

const SELECT_SERVICIO = `
  SELECT r.*, ${nombreCompleto('c')} AS cliente, t.nombre AS tour, t.duracion_hrs, COALESCE(r.destino, t.destino) AS destino_final
  FROM reservas r
  JOIN usuarios c ON c.id = r.cliente_id
  LEFT JOIN tours t ON t.id = r.tour_id`;

// ---- Mis servicios: primero los que esperan mi respuesta ----
router.get('/', verServicios, (req, res) => {
  const asignadas = db.prepare(SELECT_SERVICIO + `
    WHERE r.empleado_id = ? AND r.estado IN ('pendiente','confirmada')
    ORDER BY (r.conductor_estado = 'pendiente') DESC, r.fecha, r.hora`).all(req.session.user.id);
  res.render('empleado/dashboard', { asignadas });
});

// ---- Detalle de un servicio y respuesta (aceptar / no puedo) ----
const MENSAJES_OK = ['aceptada', 'rechazada'];

function vistaServicio(req, res, id, { error = null, ok = null } = {}, status = 200) {
  const r = db.prepare(SELECT_SERVICIO + ' WHERE r.id = ? AND r.empleado_id = ?').get(id, req.session.user.id);
  if (!r) return res.status(404).render('error', { titulo: req.t('err.404.title'), mensaje: req.t('err.404.msg') });
  res.status(status).render('empleado/servicio', {
    r,
    puedeResponder: r.estado === 'pendiente' && ['pendiente', 'aceptada'].includes(r.conductor_estado),
    ok: MENSAJES_OK.includes(ok) ? req.t('drv.ok.' + ok) : null,
    error,
  });
}

router.get('/reservas/:id', verServicios, (req, res) => vistaServicio(req, res, req.params.id, { ok: req.query.ok }));

router.post('/reservas/:id/responder', requirePermission('servicios.responder'), (req, res) => {
  const r = db.prepare('SELECT id, estado, conductor_estado FROM reservas WHERE id = ? AND empleado_id = ?').get(req.params.id, req.session.user.id);
  if (!r) return res.redirect('/empleado');
  const falla = (clave) => vistaServicio(req, res, r.id, { error: req.t(clave) }, 400);
  // Solo mientras la reserva espera su confirmación. Ya confirmada, cualquier cambio lo hace el administrador.
  if (r.estado !== 'pendiente' || !['pendiente', 'aceptada'].includes(r.conductor_estado)) return falla('drv.errState');
  const decision = req.body.decision;
  if (!['aceptar', 'rechazar'].includes(decision)) return falla('drv.errState');
  const nota = String(req.body.nota ?? '').trim().slice(0, 500);
  if (decision === 'rechazar' && nota.length < 3) return falla('drv.errReason');

  const nuevo = decision === 'aceptar' ? 'aceptada' : 'rechazada';
  if (nuevo !== r.conductor_estado) {
    db.prepare("UPDATE reservas SET conductor_estado = ?, conductor_respondido_en = datetime('now'), conductor_nota = ? WHERE id = ?")
      .run(nuevo, nuevo === 'rechazada' ? nota : (nota || null), r.id);
    avisar(nuevo === 'aceptada' ? 'conductor_acepto' : 'conductor_rechazo', r.id, { nota });
  }
  res.redirect(`/empleado/reservas/${r.id}?ok=${nuevo}`);
});

// ---- Mi disponibilidad: fechas en que NO puedo trabajar ----
const gestionarDisp = requirePermission('disponibilidad.gestionar');
const OK_DISP = ['agregada', 'quitada'];

function fechaReal(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f))) return false;
  const d = new Date(f + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && d.toLocaleDateString('en-CA') === f;
}

function vistaDisp(req, res, { error = null, ok = null, aviso = null } = {}, status = 200) {
  const hoy = hoyBogota();
  res.status(status).render('empleado/disponibilidad', {
    // Los rangos ya terminados no se muestran.
    rangos: db.prepare('SELECT * FROM indisponibilidades WHERE usuario_id = ? AND hasta >= ? ORDER BY desde').all(req.session.user.id, hoy),
    hoy,
    ok: OK_DISP.includes(ok) ? req.t('disp.ok.' + ok) : null,
    aviso, error,
  });
}

router.get('/disponibilidad', gestionarDisp, (req, res) => vistaDisp(req, res, { ok: req.query.ok }));

router.post('/disponibilidad', gestionarDisp, (req, res) => {
  const desde = String(req.body.desde ?? '').trim();
  const hasta = String(req.body.hasta ?? '').trim() || desde;
  const motivo = String(req.body.motivo ?? '').trim().slice(0, 200);
  if (!fechaReal(desde) || !fechaReal(hasta) || hasta < desde || hasta < hoyBogota()) {
    return vistaDisp(req, res, { error: req.t('disp.errDates') }, 400);
  }
  if ((Date.parse(hasta) - Date.parse(desde)) / 86400000 > 366) return vistaDisp(req, res, { error: req.t('disp.errSpan') }, 400);

  db.prepare('INSERT INTO indisponibilidades (usuario_id, desde, hasta, motivo) VALUES (?,?,?,?)').run(req.session.user.id, desde, hasta, motivo || null);
  // Si ya tiene servicios asignados en esas fechas se le avisa: debe responderlos para que se puedan reasignar.
  const cruces = serviciosEnRango(req.session.user.id, desde, hasta);
  if (cruces.length) {
    return vistaDisp(req, res, { ok: 'agregada', aviso: req.t('disp.warnConflict').replace('{ids}', cruces.map((c) => '#' + c.id).join(', ')) });
  }
  res.redirect('/empleado/disponibilidad?ok=agregada');
});

router.post('/disponibilidad/:id/eliminar', gestionarDisp, (req, res) => {
  db.prepare('DELETE FROM indisponibilidades WHERE id = ? AND usuario_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/empleado/disponibilidad?ok=quitada');
});

module.exports = router;
