const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { PERMISOS, PANELES } = require('../db/permisos');
const { calcular } = require('../lib/cotizacion');
const { redondear } = require('../lib/dinero');
const { ORDEN } = require('../lib/divisas');
const { analizar } = require('../lib/telefono');
const { nombreCompleto } = require('../lib/sql');
const ajustes = require('../lib/ajustes');
const { avisar, avisarEliminada } = require('../lib/notificaciones');
const { recogidaMs, utcMs } = require('../lib/tiempo');
const { disponibilidadConductor } = require('../lib/disponibilidad');
const pagos = require('../lib/pagos');
const { requireLogin, requirePermission, permisosDeRol } = require('../middleware/auth');

router.use(requireLogin);

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Nadie puede dar (ni tocar a quien tenga) un nivel con más permisos de los que él mismo posee.
const asignable = (req, clave) => [...permisosDeRol(clave)].every((p) => req.can(p));

const listarRoles = () => db.prepare(`
  SELECT r.*, (SELECT COUNT(*) FROM usuarios u WHERE u.rol = r.clave) AS usuarios,
         (SELECT COUNT(*) FROM rol_permisos p WHERE p.rol_id = r.id) AS permisos
  FROM roles r ORDER BY r.es_sistema DESC, r.nombre`).all();

const listarUsuarios = () => db.prepare(`
  SELECT u.id, ${nombreCompleto('u')} AS nombre, u.email, u.rol, u.activo, r.nombre AS rol_nombre, r.es_sistema AS rol_sistema
  FROM usuarios u JOIN roles r ON r.clave = u.rol ORDER BY u.id DESC`).all();

// ---- Tiempos de atención ----
// Respuesta: de que llega la solicitud a la primera acción del equipo (objetivo configurable).
// Plazo: la recogida debe ser N horas después de confirmar, así que hay un último momento para confirmar.
function tiemposDe(r) {
  const ahora = Date.now();
  const objetivo = ajustes.obtener('sla_respuesta_min') * 60000;
  const anticipacionH = ajustes.obtener('anticipacion_horas');
  const alerta = ajustes.obtener('alerta_plazo_horas') * 3600000;
  const creado = utcMs(r.creado_en);
  const respondido = r.primera_respuesta_en ? utcMs(r.primera_respuesta_en) : null;
  const espera = (respondido ?? ahora) - creado;
  const recogida = recogidaMs(r.fecha, r.hora);
  const limite = recogida - anticipacionH * 3600000;
  const restante = limite - ahora;
  const cerrada = ['completada', 'cancelada'].includes(r.estado);
  return {
    creado, respondido, espera, objetivo, recogida, limite, restante, anticipacionH,
    estadoRespuesta: respondido ? (espera <= objetivo ? 'ok' : 'tarde') : (espera > objetivo ? 'vencido' : 'esperando'),
    estadoPlazo: r.confirmada_en || r.estado === 'confirmada' ? 'confirmada' : cerrada ? 'cerrada' : restante < 0 ? 'vencido' : restante < alerta ? 'urgente' : 'ok',
  };
}
const marcarRespuesta = (id) =>
  db.prepare("UPDATE reservas SET primera_respuesta_en = COALESCE(primera_respuesta_en, datetime('now')) WHERE id = ?").run(id);

// ---- Panel ----
router.get('/', requirePermission('panel.admin'), (req, res) => {
  const count = (sql) => db.prepare(sql).get().n;
  const stats = {
    clientes: count("SELECT COUNT(*) n FROM usuarios u JOIN roles r ON r.clave = u.rol WHERE r.panel = 'cliente'"),
    empleados: count("SELECT COUNT(*) n FROM usuarios u JOIN roles r ON r.clave = u.rol WHERE r.panel = 'empleado'"),
    reservasPendientes: count("SELECT COUNT(*) n FROM reservas WHERE estado='pendiente'"),
    pagosPorVerificar: count("SELECT COUNT(*) n FROM reservas WHERE pago_estado='en_revision'"),
    vehiculos: count('SELECT COUNT(*) n FROM vehiculos'),
  };
  const pendientes = db.prepare(`
    SELECT r.id, r.fecha, r.hora, r.pasajeros, r.tipo, r.autorizacion, r.estado, r.creado_en, r.primera_respuesta_en, r.confirmada_en, r.conductor_estado,
           ${nombreCompleto('c')} AS cliente, t.nombre AS tour, COALESCE(r.destino, t.destino) AS destino_final
    FROM reservas r JOIN usuarios c ON c.id = r.cliente_id LEFT JOIN tours t ON t.id = r.tour_id
    WHERE r.estado = 'pendiente' ORDER BY r.fecha, r.hora LIMIT 8`).all().map((r) => ({ ...r, t: tiemposDe(r) }));

  // Tiempo de respuesta de los últimos 30 días y cuántas solicitudes siguen sin respuesta.
  const objetivo = ajustes.obtener('sla_respuesta_min') * 60000;
  const respuestas = db.prepare(`SELECT creado_en, primera_respuesta_en FROM reservas
    WHERE primera_respuesta_en IS NOT NULL AND creado_en >= datetime('now', '-30 days')`).all()
    .map((x) => utcMs(x.primera_respuesta_en) - utcMs(x.creado_en));
  const sinResponder = db.prepare("SELECT creado_en FROM reservas WHERE estado = 'pendiente' AND primera_respuesta_en IS NULL").all()
    .map((x) => Date.now() - utcMs(x.creado_en));
  const metricas = {
    objetivo,
    respondidas: respuestas.length,
    promedio: respuestas.length ? respuestas.reduce((a, b) => a + b, 0) / respuestas.length : null,
    dentroObjetivo: respuestas.length ? Math.round(100 * respuestas.filter((x) => x <= objetivo).length / respuestas.length) : null,
    sinResponder: sinResponder.length,
    sinResponderVencidas: sinResponder.filter((x) => x > objetivo).length,
    masAntigua: sinResponder.length ? Math.max(...sinResponder) : null,
  };
  res.render('admin/dashboard', { stats, pendientes, metricas });
});

// ---- Usuarios ----
const vistaUsuarios = (req, res, error, status = 200) => res.status(status).render('admin/usuarios', {
  usuarios: listarUsuarios(),
  roles: listarRoles().filter((r) => asignable(req, r.clave)),
  puedeGestionar: (clave) => asignable(req, clave),
  error,
});

router.get('/usuarios', requirePermission('usuarios.gestionar'), (req, res) => vistaUsuarios(req, res, null));

router.post('/usuarios', requirePermission('usuarios.gestionar'), (req, res) => {
  const { email, password, rol } = req.body;
  const limpiar = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const nombre = limpiar(req.body.nombre, 60), apellidos = limpiar(req.body.apellidos, 80);
  const existe = db.prepare('SELECT 1 FROM roles WHERE clave = ?').get(rol);
  if (!existe || !asignable(req, rol)) return vistaUsuarios(req, res, req.t('usr.errRole'), 400);
  if (!nombre || !apellidos || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()) || !password || password.length < 8) {
    return vistaUsuarios(req, res, req.t('usr.errIncomplete'), 400);
  }
  const telefono = limpiar(req.body.telefono, 30);
  const tel = telefono ? analizar(telefono) : null;
  if (telefono && !tel) return vistaUsuarios(req, res, req.t('reg.errPhone'), 400);
  try {
    db.prepare('INSERT INTO usuarios (nombre, apellidos, email, telefono, pais, idioma, password_hash, rol) VALUES (?,?,?,?,?,?,?,?)')
      .run(nombre, apellidos, email.trim().toLowerCase(), tel ? tel.e164 : null, tel ? tel.pais : null, tel ? tel.idioma : null,
        bcrypt.hashSync(password, 10), rol);
  } catch (e) {
    return vistaUsuarios(req, res, req.t('usr.errExists'), 400);
  }
  res.redirect('/admin/usuarios');
});

router.post('/usuarios/:id/toggle', requirePermission('usuarios.gestionar'), (req, res) => {
  const objetivo = db.prepare('SELECT id, rol FROM usuarios WHERE id = ?').get(req.params.id);
  if (objetivo && objetivo.id !== req.session.user.id && asignable(req, objetivo.rol)) {
    db.prepare('UPDATE usuarios SET activo = 1 - activo WHERE id = ?').run(objetivo.id);
  }
  res.redirect('/admin/usuarios');
});

// ---- Reservas ----
const ESTADOS = ['pendiente', 'confirmada', 'completada', 'cancelada'];
// A qué estados se puede pasar desde cada uno. 'completada' es definitivo.
const TRANSICIONES = {
  pendiente: ['confirmada', 'cancelada'],
  confirmada: ['completada', 'cancelada', 'pendiente'],
  completada: [],
  cancelada: ['pendiente'],
};
const MENSAJES_OK = ['cotizada', 'asignada', 'estado', 'autorizacion', 'pago'];

const SELECT_ADMIN = `
  SELECT r.*, ${nombreCompleto('c')} AS cliente, c.email AS cliente_email, c.telefono AS cliente_tel,
         c.pais AS cliente_pais, c.idioma AS cliente_idioma,
         t.nombre AS tour, t.precio AS tour_precio, t.moneda AS tour_moneda, t.duracion_hrs, COALESCE(r.destino, t.destino) AS destino_final,
         ${nombreCompleto('e')} AS empleado, v.placa, v.tipo AS vehiculo_tipo
  FROM reservas r
  JOIN usuarios c ON c.id = r.cliente_id
  LEFT JOIN tours t ON t.id = r.tour_id
  LEFT JOIN usuarios e ON e.id = r.empleado_id
  LEFT JOIN vehiculos v ON v.id = r.vehiculo_id`;

router.get('/reservas', requirePermission('reservas.ver_todas'), (req, res) => {
  const filtro = ESTADOS.includes(req.query.estado) ? req.query.estado : null;
  const filtroPago = req.query.pago === 'en_revision' ? 'en_revision' : null;
  const donde = [], params = [];
  if (filtro) { donde.push('r.estado = ?'); params.push(filtro); }
  if (filtroPago) { donde.push('r.pago_estado = ?'); params.push(filtroPago); }
  const reservas = db.prepare(SELECT_ADMIN + (donde.length ? ' WHERE ' + donde.join(' AND ') : '') +
    " ORDER BY (r.estado = 'pendiente') DESC, r.fecha DESC, r.hora DESC").all(...params);
  const ok = req.query.ok === 'eliminada' && /^\d+$/.test(String(req.query.id)) ? req.t('del.ok').replace('{id}', req.query.id) : null;
  res.render('admin/reservas', { reservas: reservas.map((r) => ({ ...r, t: tiemposDe(r) })), filtro, filtroPago, estados: ESTADOS, ok });
});

// Historial de reservas eliminadas (debe ir antes de /reservas/:id para que "eliminadas" no se lea como un número).
router.get('/reservas/eliminadas', requirePermission('reservas.eliminar'), (req, res) => {
  const filas = db.prepare('SELECT * FROM reservas_eliminadas ORDER BY id DESC LIMIT 200').all();
  res.render('admin/eliminadas', { filas: filas.map((f) => ({ ...f, r: JSON.parse(f.resumen) })) });
});

// Lo que debe cumplirse para que el administrador pueda confirmar la reserva al cliente.
function requisitosDe(r) {
  const horas = ajustes.obtener('anticipacion_horas');
  const sinCondiciones = r.autorizacion === 'no_requiere';
  return [
    { clave: 'quote', ok: r.total != null },
    { clave: sinCondiciones ? 'authNA' : 'auth', ok: sinCondiciones || r.autorizacion === 'autorizada' },
    { clave: 'driver', ok: !!r.empleado_id && r.conductor_estado === 'aceptada' },
    { clave: 'lead', ok: recogidaMs(r.fecha, r.hora) >= Date.now() + horas * 3600000, horas },
    { clave: 'pay', ok: r.pago_estado === 'confirmado' },
  ];
}

function vistaReserva(req, res, id, { error = null, ok = null } = {}, status = 200) {
  const r = db.prepare(SELECT_ADMIN + ' WHERE r.id = ?').get(id);
  if (!r) return res.status(404).render('error', { titulo: req.t('err.404.title'), mensaje: req.t('err.404.msg') });
  res.status(status).render('admin/reserva', {
    r,
    tiempos: tiemposDe(r),
    clienteTel: (analizar(r.cliente_tel) || {}).internacional || r.cliente_tel,
    cot: r.total == null ? null : calcular({
      km: r.km, precio_km: r.precio_km, minimo: r.tarifa_minima, peajes: r.peajes, viaticos: r.viaticos,
      decimales: req.divisas[r.moneda || 'USD'].decimales,
    }),
    monedaCot: r.moneda || (req.divisas[r.moneda_solicitada] ? r.moneda_solicitada : 'USD'),
    tarifas: db.prepare('SELECT * FROM tarifas WHERE activo = 1 ORDER BY nombre').all(),
    // Cada conductor con su disponibilidad para ESTE servicio (libre / ocupado con otra reserva / fechas no disponibles).
    conductores: db.prepare(`SELECT u.id, ${nombreCompleto('u')} AS nombre FROM usuarios u JOIN roles ro ON ro.clave = u.rol
                             WHERE ro.panel = 'empleado' AND u.activo = 1 ORDER BY u.nombre`).all()
      .map((e) => ({ ...e, disp: disponibilidadConductor(e.id, { id: r.id, fecha: r.fecha, hora: r.hora, duracion_hrs: r.duracion_hrs }) })),
    requisitos: requisitosDe(r),
    nequi: pagos.nequiEmpresa(),
    montoPago: r.pago_monto_cop ?? pagos.montoCOP(r, req.divisas),
    vehiculos: db.prepare("SELECT * FROM vehiculos WHERE estado != 'mantenimiento' OR id = ? ORDER BY placa").all(r.vehiculo_id ?? 0),
    siguientes: TRANSICIONES[r.estado],
    abierta: ['pendiente', 'confirmada'].includes(r.estado),
    ok: ok && MENSAJES_OK.includes(ok) ? req.t('res.ok.' + ok) : null,
    error,
  });
}

router.get('/reservas/:id', requirePermission('reservas.ver_todas'), (req, res) =>
  vistaReserva(req, res, req.params.id, { ok: req.query.ok }));

const gestionarReservas = requirePermission('reservas.gestionar');
const num = (v) => (String(v ?? '').trim() === '' ? 0 : Number(String(v).replace(',', '.')));
const dinero = (n) => Number.isFinite(n) && n >= 0 && n <= 1e9; // tope de cordura (en COP las cifras son grandes)

router.post('/reservas/:id/cotizar', gestionarReservas, (req, res) => {
  const r = db.prepare('SELECT id, estado, pago_estado FROM reservas WHERE id = ?').get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  if (!['pendiente', 'confirmada'].includes(r.estado)) return falla('res.errClosed');
  // Con comprobante enviado o pago confirmado el valor ya no puede cambiar (el cliente pagó esa cifra).
  if (['en_revision', 'confirmado'].includes(r.pago_estado)) return falla('res.errPaid');
  const tarifa = db.prepare('SELECT * FROM tarifas WHERE id = ? AND activo = 1').get(req.body.tarifa_id);
  if (!tarifa) return falla('res.errTarifa');
  const moneda = req.divisas[req.body.moneda];
  if (!moneda) return falla('res.errCurrency');
  const km = num(req.body.km);
  const peajes = redondear(num(req.body.peajes), moneda.decimales);
  const viaticos = redondear(num(req.body.viaticos), moneda.decimales);
  if (!(km > 0 && km <= 20000) || !dinero(peajes) || !dinero(viaticos)) return falla('res.errQuote');

  // La tarifa puede estar en otra moneda: se convierte a la de la cotización con las tasas de hoy,
  // y se guarda el resultado (más la moneda original y el factor) para que no cambie después.
  const origen = req.divisas[tarifa.moneda] || req.divisas.USD;
  const factor = moneda.tasa / origen.tasa;
  const precioKm = redondear(tarifa.precio_km * factor, 6);
  const minimo = redondear(tarifa.tarifa_minima * factor, 6);
  const { total } = calcular({ km, precio_km: precioKm, minimo, peajes, viaticos, decimales: moneda.decimales });
  db.prepare(`UPDATE reservas SET tarifa_nombre = ?, precio_km = ?, tarifa_minima = ?, km = ?, peajes = ?, viaticos = ?,
              total = ?, moneda = ?, tarifa_moneda = ?, factor = ?, cotizado_en = datetime('now') WHERE id = ?`)
    .run(tarifa.nombre, precioKm, minimo, km, peajes, viaticos, total, moneda.codigo, origen.codigo, factor, r.id);
  marcarRespuesta(r.id);
  avisar('cotizada', r.id);
  res.redirect(`/admin/reservas/${r.id}?ok=cotizada`);
});

router.post('/reservas/:id/asignar', gestionarReservas, (req, res) => {
  const r = db.prepare(`SELECT r.id, r.estado, r.pasajeros, r.fecha, r.hora, r.empleado_id, t.duracion_hrs
                        FROM reservas r LEFT JOIN tours t ON t.id = r.tour_id WHERE r.id = ?`).get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  if (!['pendiente', 'confirmada'].includes(r.estado)) return falla('res.errClosed');

  let empleadoId = null;
  if (req.body.empleado_id) {
    const e = db.prepare(`SELECT u.id FROM usuarios u JOIN roles ro ON ro.clave = u.rol
                          WHERE u.id = ? AND ro.panel = 'empleado' AND u.activo = 1`).get(req.body.empleado_id);
    if (!e) return falla('res.errDriver');
    empleadoId = e.id;
  }
  const cambiaConductor = empleadoId !== (r.empleado_id ?? null);
  // Con la reserva confirmada el conductor ya aceptó: cambiarlo obliga a volver a pendiente (y a que el nuevo acepte).
  if (cambiaConductor && r.estado === 'confirmada') return falla('res.errAssignConfirmed');
  if (empleadoId && cambiaConductor) {
    const d = disponibilidadConductor(empleadoId, r);
    if (!d.libre) {
      const msg = d.motivo === 'ocupado'
        ? req.t('res.errDriverBusy').replace('{id}', d.reservaId)
        : req.t('res.errDriverOff').replace('{desde}', d.desde).replace('{hasta}', d.hasta);
      return vistaReserva(req, res, r.id, { error: msg }, 400);
    }
  }
  let vehiculoId = null;
  if (req.body.vehiculo_id) {
    const v = db.prepare("SELECT id, capacidad FROM vehiculos WHERE id = ? AND estado != 'mantenimiento'").get(req.body.vehiculo_id);
    if (!v) return falla('res.errVehicle');
    if (v.capacidad < r.pasajeros) return falla('res.errCapacity');
    vehiculoId = v.id;
  }
  if (cambiaConductor) {
    // Conductor nuevo (o quitado): vuelve a empezar la confirmación del conductor.
    db.prepare(`UPDATE reservas SET empleado_id = ?, vehiculo_id = ?, conductor_estado = ?,
                conductor_asignado_en = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
                conductor_respondido_en = NULL, conductor_nota = NULL, alerta_conductor_en = NULL WHERE id = ?`)
      .run(empleadoId, vehiculoId, empleadoId ? 'pendiente' : 'sin_asignar', empleadoId, r.id);
    if (r.empleado_id) { // al anterior se le avisa que ya no es su servicio
      const anterior = db.prepare('SELECT idioma FROM usuarios WHERE id = ?').get(r.empleado_id);
      avisar('asignacion_cancelada', r.id, {}, [{ id: r.empleado_id, idioma: anterior && anterior.idioma }]);
    }
    if (empleadoId) avisar('asignacion', r.id); // el nuevo recibe el aviso para aceptar o rechazar
  } else {
    db.prepare('UPDATE reservas SET vehiculo_id = ? WHERE id = ?').run(vehiculoId, r.id);
  }
  res.redirect(`/admin/reservas/${r.id}?ok=asignada`);
});

router.post('/reservas/:id/estado', gestionarReservas, (req, res) => {
  const r = db.prepare('SELECT id, estado, total, autorizacion, fecha, hora, empleado_id, conductor_estado, pago_estado FROM reservas WHERE id = ?').get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const nuevo = req.body.estado;
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  if (!TRANSICIONES[r.estado].includes(nuevo)) return falla('res.errTransition');
  if (nuevo === 'confirmada' && r.total == null) return falla('res.errNeedQuote');
  if (nuevo === 'confirmada' && r.autorizacion === 'pendiente') return falla('res.errNeedAuth');
  if (nuevo === 'confirmada' && r.autorizacion === 'rechazada') return falla('res.errRejected');
  // El conductor devuelve la reserva al administrador (acepta o rechaza); solo con su "sí" se puede confirmar.
  if (nuevo === 'confirmada' && !r.empleado_id) return falla('res.errNeedDriver');
  if (nuevo === 'confirmada' && r.conductor_estado === 'pendiente') return falla('res.errDriverPending');
  if (nuevo === 'confirmada' && r.conductor_estado === 'rechazada') return falla('res.errDriverRejected');
  // La reserva se confirma al verificar el pago; esta vía solo sirve para re-confirmar un pago ya verificado.
  if (nuevo === 'confirmada' && r.pago_estado !== 'confirmado') return falla('res.errNeedPayment');
  // Formalizar = confirmar. Desde ese momento deben quedar, como mínimo, N horas (24) hasta la recogida.
  if (nuevo === 'confirmada' && recogidaMs(r.fecha, r.hora) < Date.now() + ajustes.obtener('anticipacion_horas') * 3600000) {
    return vistaReserva(req, res, r.id, { error: req.t('res.errLead').replace('{horas}', ajustes.obtener('anticipacion_horas')) }, 400);
  }
  db.prepare(`UPDATE reservas SET estado = ?,
              confirmada_en = CASE WHEN ? = 'confirmada' THEN datetime('now') WHEN ? = 'pendiente' THEN NULL ELSE confirmada_en END
              WHERE id = ?`).run(nuevo, nuevo, nuevo, r.id);
  marcarRespuesta(r.id);
  if (nuevo === 'confirmada' || nuevo === 'cancelada') {
    avisar(nuevo, r.id); // al cliente
    avisar(nuevo === 'confirmada' ? 'servicio_confirmado' : 'asignacion_cancelada', r.id); // y al conductor, si hay uno asignado
  }
  res.redirect(`/admin/reservas/${r.id}?ok=estado`);
});

// ---- Eliminar una reserva ----
// Por ahora solo el administrador, con una justificación obligatoria (p. ej. "es una prueba"). Se borra la reserva con su
// comprobante de pago y sus avisos, pero queda un registro de quién la eliminó y por qué. (En producción la eliminación
// deberá autorizarla el cliente que hizo la reserva.)
router.post('/reservas/:id/eliminar', requirePermission('reservas.eliminar'), (req, res) => {
  const r = db.prepare(SELECT_ADMIN + ' WHERE r.id = ?').get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  const motivo = String(req.body.motivo ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
  if (motivo.length < 5) return falla('del.errReason');
  if (req.body.confirmo !== '1') return falla('del.errConfirm');

  const avisar_ = req.body.avisar === '1';
  const resumen = {
    tipo: r.tipo, servicio: r.tipo === 'tour' ? r.tour : null, destino: r.destino_final, fecha: r.fecha, hora: r.hora, pasajeros: r.pasajeros,
    estado: r.estado, conductor: r.empleado, conductor_estado: r.conductor_estado,
    total: r.total, moneda: r.moneda, pago_estado: r.pago_estado, pago_monto_cop: r.pago_monto_cop, pago_referencia: r.pago_referencia,
  };
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO reservas_eliminadas (reserva_id, cliente_id, cliente_nombre, resumen, motivo, eliminado_por, eliminado_por_nombre, avisado)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(r.id, r.cliente_id, r.cliente, JSON.stringify(resumen), motivo, req.session.user.id, req.session.user.nombre, avisar_ ? 1 : 0);
    db.prepare('DELETE FROM notificaciones WHERE reserva_id = ?').run(r.id); // sus avisos apuntarían a una reserva que ya no existe
    db.prepare('DELETE FROM reservas WHERE id = ?').run(r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (r.pago_evidencia) pagos.borrarEvidencia(r.pago_evidencia); // el archivo se borra solo si la eliminación quedó confirmada
  if (avisar_) avisarEliminada(r, motivo);
  res.redirect(`/admin/reservas?ok=eliminada&id=${r.id}`);
});

// ---- Verificación del pago (Nequi simulado) ----
// El administrador revisa en la evidencia el valor, el número Nequi de la empresa y el código de la reserva.
// Al confirmar el pago la reserva queda confirmada; al rechazarlo el cliente puede corregirlo y reenviarlo.
router.post('/reservas/:id/pago', requirePermission('pagos.verificar'), (req, res) => {
  const r = db.prepare('SELECT id, estado, pago_estado, total, autorizacion, fecha, hora, empleado_id, conductor_estado FROM reservas WHERE id = ?').get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  if (r.pago_estado !== 'en_revision' || r.estado !== 'pendiente') return falla('res.errPayState');

  if (req.body.decision === 'rechazar') {
    const nota = String(req.body.nota ?? '').trim().slice(0, 500);
    if (nota.length < 3) return falla('res.errPayNote');
    db.prepare("UPDATE reservas SET pago_estado = 'rechazado', pago_nota = ?, pago_revisado_en = datetime('now') WHERE id = ?").run(nota, r.id);
    marcarRespuesta(r.id);
    avisar('pago_rechazado', r.id, { nota });
    return res.redirect(`/admin/reservas/${r.id}?ok=pago`);
  }
  if (req.body.decision !== 'confirmar') return falla('res.errPayState');

  // Confirmar el pago confirma la reserva, así que también deben cumplirse todos los demás requisitos.
  if (r.total == null) return falla('res.errNeedQuote');
  if (r.autorizacion === 'pendiente') return falla('res.errNeedAuth');
  if (r.autorizacion === 'rechazada') return falla('res.errRejected');
  if (!r.empleado_id) return falla('res.errNeedDriver');
  if (r.conductor_estado === 'pendiente') return falla('res.errDriverPending');
  if (r.conductor_estado === 'rechazada') return falla('res.errDriverRejected');
  const horas = ajustes.obtener('anticipacion_horas');
  if (recogidaMs(r.fecha, r.hora) < Date.now() + horas * 3600000) {
    return vistaReserva(req, res, r.id, { error: req.t('res.errLead').replace('{horas}', horas) }, 400);
  }
  db.prepare(`UPDATE reservas SET pago_estado = 'confirmado', pago_nota = NULL, pago_revisado_en = datetime('now'),
              estado = 'confirmada', confirmada_en = datetime('now') WHERE id = ?`).run(r.id);
  marcarRespuesta(r.id);
  avisar('pago_confirmado', r.id);        // al cliente: pago verificado y reserva confirmada
  avisar('servicio_confirmado', r.id);    // al conductor
  res.redirect(`/admin/reservas/${r.id}?ok=pago`);
});

router.get('/reservas/:id/evidencia', requirePermission('reservas.ver_todas', 'pagos.verificar'), (req, res) => {
  const r = db.prepare('SELECT id, pago_evidencia, pago_evidencia_tipo FROM reservas WHERE id = ?').get(req.params.id);
  if (!r || !r.pago_evidencia) return res.status(404).end();
  pagos.enviarEvidencia(res, r);
});

// Autorización del transporte con mascotas o niños: se decide mientras la reserva está pendiente.
router.post('/reservas/:id/autorizacion', gestionarReservas, (req, res) => {
  const r = db.prepare('SELECT id, estado, autorizacion FROM reservas WHERE id = ?').get(req.params.id);
  if (!r) return res.redirect('/admin/reservas');
  const falla = (clave) => vistaReserva(req, res, r.id, { error: req.t(clave) }, 400);
  if (r.autorizacion === 'no_requiere' || r.estado !== 'pendiente') return falla('res.errAuthState');
  const decision = req.body.decision;
  if (!['autorizada', 'rechazada'].includes(decision)) return falla('res.errAuthState');
  const nota = String(req.body.nota ?? '').trim().slice(0, 500);
  if (decision === 'rechazada' && nota.length < 3) return falla('res.errAuthNote');
  db.prepare("UPDATE reservas SET autorizacion = ?, autorizacion_nota = ?, autorizado_en = datetime('now') WHERE id = ?")
    .run(decision, nota || null, r.id);
  marcarRespuesta(r.id);
  avisar(decision, r.id, { nota });
  res.redirect(`/admin/reservas/${r.id}?ok=autorizacion`);
});

// ---- Ajustes de atención (tiempos objetivo y anticipación) ----
const gestionarAjustes = requirePermission('ajustes.gestionar');
const vistaAjustes = (req, res, { error = null, ok = null } = {}, status = 200) =>
  res.status(status).render('admin/ajustes', { valores: ajustes.todos(), limites: ajustes.LIMITES, nequi: pagos.nequiEmpresa(), error, ok });

router.get('/ajustes', gestionarAjustes, (req, res) => vistaAjustes(req, res, { ok: req.query.ok === '1' ? req.t('aju.ok') : null }));

router.post('/ajustes', gestionarAjustes, (req, res) => {
  const nuevos = {};
  for (const [clave, [min, max]] of Object.entries(ajustes.LIMITES)) {
    const n = Number(String(req.body[clave] ?? '').replace(',', '.'));
    if (!Number.isInteger(n) || n < min || n > max) return vistaAjustes(req, res, { error: req.t('aju.err') }, 400);
    nuevos[clave] = n;
  }
  // Cuenta Nequi de la empresa (vacía = los clientes todavía no pueden pagar).
  const numeroCrudo = String(req.body.nequi_numero ?? '').trim();
  const nequi = numeroCrudo ? pagos.nequiValido(numeroCrudo) : '';
  if (numeroCrudo && !nequi) return vistaAjustes(req, res, { error: req.t('aju.errNequi') }, 400);
  for (const [clave, n] of Object.entries(nuevos)) ajustes.guardar(clave, n);
  ajustes.guardar('nequi_numero', nequi);
  ajustes.guardar('nequi_titular', String(req.body.nequi_titular ?? '').trim().replace(/\s+/g, ' ').slice(0, 60));
  res.redirect('/admin/ajustes?ok=1');
});

// ---- Tarifario por kilómetro ----
const gestionarTarifas = requirePermission('tarifas.gestionar');
const leerTarifa = (body, t, divisas) => {
  const nombre = String(body.nombre || '').trim().slice(0, 80);
  const precio = num(body.precio_km), minimo = num(body.tarifa_minima);
  if (!nombre) return { error: t('tar.errName') };
  if (!divisas[body.moneda]) return { error: t('res.errCurrency') };
  if (!(precio > 0 && precio <= 1e7)) return { error: t('tar.errPrice') };
  if (!dinero(minimo)) return { error: t('tar.errMin') };
  return { nombre, precio, minimo, moneda: body.moneda };
};
const vistaTarifas = (req, res, error, status = 200) => res.status(status).render('admin/tarifas', {
  tarifas: db.prepare('SELECT * FROM tarifas ORDER BY activo DESC, nombre').all(), error,
});

router.get('/tarifas', gestionarTarifas, (req, res) => vistaTarifas(req, res, null));

router.post('/tarifas', gestionarTarifas, (req, res) => {
  const t = leerTarifa(req.body, req.t, req.divisas);
  if (t.error) return vistaTarifas(req, res, t.error, 400);
  db.prepare('INSERT INTO tarifas (nombre, precio_km, tarifa_minima, moneda) VALUES (?,?,?,?)').run(t.nombre, t.precio, t.minimo, t.moneda);
  res.redirect('/admin/tarifas');
});

router.get('/tarifas/:id', gestionarTarifas, (req, res) => {
  const tarifa = db.prepare('SELECT * FROM tarifas WHERE id = ?').get(req.params.id);
  if (!tarifa) return res.redirect('/admin/tarifas');
  res.render('admin/tarifa', { tarifa, error: null });
});

router.post('/tarifas/:id', gestionarTarifas, (req, res) => {
  const tarifa = db.prepare('SELECT * FROM tarifas WHERE id = ?').get(req.params.id);
  if (!tarifa) return res.redirect('/admin/tarifas');
  const t = leerTarifa(req.body, req.t, req.divisas);
  if (t.error) {
    return res.status(400).render('admin/tarifa', {
      tarifa: { ...tarifa, nombre: req.body.nombre, precio_km: req.body.precio_km, tarifa_minima: req.body.tarifa_minima, moneda: req.body.moneda, activo: req.body.activo ? 1 : 0 },
      error: t.error,
    });
  }
  db.prepare('UPDATE tarifas SET nombre = ?, precio_km = ?, tarifa_minima = ?, moneda = ?, activo = ? WHERE id = ?')
    .run(t.nombre, t.precio, t.minimo, t.moneda, req.body.activo ? 1 : 0, tarifa.id);
  res.redirect('/admin/tarifas');
});

// ---- Divisas y tasas de cambio ----
const gestionarDivisas = requirePermission('divisas.gestionar');
const vistaDivisas = (req, res, { error = null, ok = null } = {}, status = 200) =>
  res.status(status).render('admin/divisas', { orden: ORDEN.filter((c) => req.divisas[c]), error, ok });

router.get('/divisas', gestionarDivisas, (req, res) =>
  vistaDivisas(req, res, { ok: req.query.ok === '1' ? req.t('div.ok') : null }));

router.post('/divisas', gestionarDivisas, (req, res) => {
  const nuevas = {};
  for (const codigo of ORDEN) {
    if (codigo === 'USD' || !req.divisas[codigo]) continue; // USD es la base: siempre vale 1
    const tasa = Number(String(req.body['tasa_' + codigo] ?? '').replace(',', '.'));
    if (!(Number.isFinite(tasa) && tasa > 0 && tasa <= 1e9)) return vistaDivisas(req, res, { error: req.t('div.errRate') }, 400);
    nuevas[codigo] = tasa;
  }
  const upd = db.prepare("UPDATE divisas SET tasa = ?, actualizada_en = datetime('now') WHERE codigo = ? AND tasa != ?");
  for (const [codigo, tasa] of Object.entries(nuevas)) upd.run(tasa, codigo, tasa);
  res.redirect('/admin/divisas?ok=1');
});

// ---- Niveles de acceso ----
const gestionarRoles = requirePermission('roles.gestionar');
const vistaRoles = (req, res, error, status = 200) =>
  res.status(status).render('admin/roles', { roles: listarRoles(), paneles: PANELES, error });

router.get('/roles', gestionarRoles, (req, res) => vistaRoles(req, res, null));

router.post('/roles', gestionarRoles, (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  const clave = slug(nombre);
  if (!nombre || !clave || !PANELES.includes(req.body.panel)) return vistaRoles(req, res, req.t('roles.errName'), 400);
  if (db.prepare('SELECT 1 FROM roles WHERE clave = ?').get(clave)) return vistaRoles(req, res, req.t('roles.errExists'), 400);
  const { lastInsertRowid } = db.prepare('INSERT INTO roles (clave, nombre, panel) VALUES (?,?,?)').run(clave, nombre, req.body.panel);
  res.redirect('/admin/roles/' + lastInsertRowid);
});

router.get('/roles/:id', gestionarRoles, (req, res) => {
  const rol = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!rol) return res.redirect('/admin/roles');
  res.render('admin/rol', { rol, permisos: PERMISOS, actuales: permisosDeRol(rol.clave), paneles: PANELES, error: null });
});

router.post('/roles/:id', gestionarRoles, (req, res) => {
  const rol = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!rol || rol.clave === 'admin') return res.redirect('/admin/roles');

  // Solo se pueden conceder o quitar permisos que uno mismo posee; el resto queda como estaba.
  const marcados = [].concat(req.body.permisos || []).filter((p) => PERMISOS.includes(p) && req.can(p));
  const conservados = [...permisosDeRol(rol.clave)].filter((p) => !req.can(p));
  const finales = new Set([...marcados, ...conservados]);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM rol_permisos WHERE rol_id = ?').run(rol.id);
    const ins = db.prepare('INSERT INTO rol_permisos (rol_id, permiso) VALUES (?,?)');
    for (const p of finales) ins.run(rol.id, p);
    if (!rol.es_sistema) {
      const nombre = (req.body.nombre || '').trim() || rol.nombre;
      const panel = PANELES.includes(req.body.panel) ? req.body.panel : rol.panel;
      db.prepare('UPDATE roles SET nombre = ?, panel = ? WHERE id = ?').run(nombre, panel, rol.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.redirect('/admin/roles');
});

router.post('/roles/:id/eliminar', gestionarRoles, (req, res) => {
  const rol = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!rol || rol.es_sistema) return res.redirect('/admin/roles');
  if (db.prepare('SELECT 1 FROM usuarios WHERE rol = ?').get(rol.clave)) return vistaRoles(req, res, req.t('roles.errInUse'), 400);
  db.prepare('DELETE FROM roles WHERE id = ?').run(rol.id);
  res.redirect('/admin/roles');
});

module.exports = router;
