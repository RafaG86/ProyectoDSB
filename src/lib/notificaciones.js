// Avisos del sistema: se guardan en la campana de la app y, si la persona activó las notificaciones en su
// celular o navegador, se envían también como notificación push (Web Push con claves VAPID).
const webpush = require('web-push');
const db = require('../db/database');
const ajustes = require('./ajustes');
const { obtenerDivisas } = require('./divisas');
const { formatear } = require('./dinero');
const { nombreCompleto } = require('./sql');
const { recogidaMs, utcMs, duracion, enBogota } = require('./tiempo');
const { traductor } = require('../i18n');

// destino: a quién va. urgente: la notificación del celular se queda hasta que se toque.
const EVENTOS = {
  nueva_reserva:   { destino: 'admin', urgente: true },     // llegó una solicitud: hay que empezar a revisarla
  sla_vencido:     { destino: 'admin', urgente: true },     // pasó el tiempo objetivo de respuesta y nadie ha respondido
  plazo_cerca:     { destino: 'admin', urgente: true },     // se acaba el plazo para confirmar (24 h antes de la recogida)
  cancelada_cliente: { destino: 'admin' },
  conductor_acepto:  { destino: 'admin', urgente: true },     // el conductor aceptó: ya se puede confirmar la reserva
  conductor_rechazo: { destino: 'admin', urgente: true },     // el conductor no puede: hay que asignar a otro
  conductor_sin_respuesta: { destino: 'admin', urgente: true }, // el conductor no responde
  asignacion:        { destino: 'conductor', urgente: true }, // nuevo servicio por aceptar o rechazar
  asignacion_cancelada: { destino: 'conductor' },             // ya no es su servicio (reasignado o cancelado)
  servicio_confirmado:  { destino: 'conductor' },             // el administrador confirmó la reserva
  cotizada:        { destino: 'cliente' },
  confirmada:      { destino: 'cliente' },
  autorizada:      { destino: 'cliente' },
  rechazada:       { destino: 'cliente' },
  cancelada:       { destino: 'cliente' },
  pago_enviado:    { destino: 'pagos', urgente: true },        // el cliente subió el comprobante: hay que verificarlo
  pago_confirmado: { destino: 'cliente' },                     // pago verificado: la reserva quedó confirmada
  pago_rechazado:  { destino: 'cliente' },                     // el comprobante no se pudo verificar
  prueba:          { destino: 'propio' },
};

const fmt = (texto, vars) => String(texto).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
const IDIOMAS = ['es', 'en', 'pt'];
const idiomaDe = (idioma) => (IDIOMAS.includes(idioma) ? idioma : 'es'); // sin idioma conocido, el de la empresa

// ---- Claves VAPID: se generan una vez y quedan en la base de datos (con sus respaldos) ----
let configurado = false;
function configurar() {
  if (configurado) return;
  let publica = ajustes.leerTexto('vapid_public');
  let privada = ajustes.leerTexto('vapid_private');
  if (!publica || !privada) {
    const claves = webpush.generateVAPIDKeys();
    publica = claves.publicKey; privada = claves.privateKey;
    db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('vapid_public', ?), ('vapid_private', ?)").run(publica, privada);
  }
  // En producción conviene poner un correo real de la empresa en VAPID_SUBJECT.
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:notificaciones@dsb.local', publica, privada);
  configurado = true;
}
const clavePublica = () => { configurar(); return ajustes.leerTexto('vapid_public'); };

// ---- Destinatarios ----
// Quien puede gestionar reservas (el administrador y los niveles con ese permiso).
function destinatariosAdmin() {
  return db.prepare(`
    SELECT u.id, u.idioma FROM usuarios u JOIN roles r ON r.clave = u.rol
    WHERE u.activo = 1 AND (u.rol = 'admin' OR EXISTS (
      SELECT 1 FROM rol_permisos p WHERE p.rol_id = r.id AND p.permiso = 'reservas.gestionar'))`).all();
}

// Quien puede verificar pagos (el administrador y los niveles con ese permiso).
function destinatariosPagos() {
  return db.prepare(`
    SELECT u.id, u.idioma FROM usuarios u JOIN roles r ON r.clave = u.rol
    WHERE u.activo = 1 AND (u.rol = 'admin' OR EXISTS (
      SELECT 1 FROM rol_permisos p WHERE p.rol_id = r.id AND p.permiso = 'pagos.verificar'))`).all();
}

// ---- Envío push ----
// PUSH_SIMULADO=1 (solo para pruebas) no sale a internet: deja constancia en la tabla push_simulado.
async function enviarPush(usuarioId, carga) {
  const subs = db.prepare('SELECT * FROM suscripciones_push WHERE usuario_id = ?').all(usuarioId);
  if (!subs.length) return;
  if (process.env.PUSH_SIMULADO === '1') {
    db.exec('CREATE TABLE IF NOT EXISTS push_simulado (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, endpoint TEXT, carga TEXT)');
    const ins = db.prepare('INSERT INTO push_simulado (usuario_id, endpoint, carga) VALUES (?,?,?)');
    for (const s of subs) ins.run(usuarioId, s.endpoint, JSON.stringify(carga));
    return;
  }
  configurar();
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(carga), { TTL: 3600, urgency: carga.urgente ? 'high' : 'normal' });
    } catch (e) {
      // 404/410: el dispositivo ya no existe (desinstaló la app o revocó el permiso).
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM suscripciones_push WHERE id = ?').run(s.id);
      else console.error('Push no enviado:', e.statusCode || e.message);
    }
  }
}

function datosReserva(id) {
  const r = db.prepare(`
    SELECT r.*, ${nombreCompleto('c')} AS cliente, c.idioma AS cliente_idioma, COALESCE(r.destino, t.destino) AS destino_final,
           ${nombreCompleto('e')} AS conductor, e.idioma AS conductor_idioma
    FROM reservas r JOIN usuarios c ON c.id = r.cliente_id LEFT JOIN tours t ON t.id = r.tour_id
    LEFT JOIN usuarios e ON e.id = r.empleado_id WHERE r.id = ?`).get(id);
  return r || null;
}

// Crea el aviso (en la app) y lo envía por push. Devuelve cuántas personas avisó.
function avisar(tipo, reservaId, extra = {}, destinatarios = null) {
  const evento = EVENTOS[tipo];
  const r = reservaId ? datosReserva(reservaId) : null;
  if (!evento || (reservaId && !r)) return 0;
  const lista = destinatarios
    || (evento.destino === 'admin' ? destinatariosAdmin()
      : evento.destino === 'pagos' ? destinatariosPagos()
      : evento.destino === 'cliente' ? [{ id: r.cliente_id, idioma: r.cliente_idioma }]
      : evento.destino === 'conductor' && r.empleado_id ? [{ id: r.empleado_id, idioma: r.conductor_idioma }] : []);

  const divisas = obtenerDivisas();
  const ins = db.prepare('INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, url, reserva_id) VALUES (?,?,?,?,?,?)');
  for (const dest of lista) {
    const lang = idiomaDe(dest.idioma);
    const t = traductor(lang);
    const vars = r ? {
      id: r.id, cliente: r.cliente, conductor: r.conductor || '', destino: r.destino_final, fecha: r.fecha, hora: r.hora || '', pax: r.pasajeros,
      monto: r.pago_monto_cop != null ? formatear(r.pago_monto_cop, 'COP', 0, lang) : '',
      total: r.total != null && divisas[r.moneda] ? formatear(r.total, r.moneda, divisas[r.moneda].decimales, lang) : '',
      ...extra,
    } : { ...extra };
    const titulo = fmt(t(`notif.${tipo}.titulo`), vars);
    const cuerpo = fmt(t(`notif.${tipo}.cuerpo`), vars);
    const url = !r ? '/notificaciones'
      : evento.destino === 'cliente' ? `/cliente/reservas/${r.id}`
      : evento.destino === 'conductor' ? (tipo === 'asignacion_cancelada' ? '/empleado' : `/empleado/reservas/${r.id}`)
      : `/admin/reservas/${r.id}`;
    ins.run(dest.id, tipo, titulo, cuerpo, url, r ? r.id : null);
    // `tag` agrupa avisos de la misma reserva: el nuevo reemplaza al anterior en el celular.
    enviarPush(dest.id, { titulo, cuerpo, url, tag: r ? `reserva-${r.id}` : tipo, urgente: !!evento.urgente })
      .catch((e) => console.error('Push:', e.message));
  }
  return lista.length;
}

// Se llama cada minuto: avisa de solicitudes sin responder y de plazos que se acaban. Cada alerta sale una sola vez.
function revisarAlertas(ahora = Date.now()) {
  const slaMs = ajustes.obtener('sla_respuesta_min') * 60000;
  const anticipacionMs = ajustes.obtener('anticipacion_horas') * 3600000;
  const alertaMs = ajustes.obtener('alerta_plazo_horas') * 3600000;
  let enviadas = 0;

  const pendientes = db.prepare("SELECT id, fecha, hora, creado_en, primera_respuesta_en, alerta_sla_en, alerta_plazo_en FROM reservas WHERE estado = 'pendiente'").all();
  for (const r of pendientes) {
    if (!r.primera_respuesta_en && !r.alerta_sla_en) {
      const espera = ahora - utcMs(r.creado_en);
      if (espera > slaMs) {
        db.prepare("UPDATE reservas SET alerta_sla_en = datetime('now') WHERE id = ?").run(r.id);
        enviadas += avisar('sla_vencido', r.id, { espera: duracion(espera), objetivo: duracion(slaMs) });
      }
    }
    if (!r.alerta_plazo_en) {
      const restante = recogidaMs(r.fecha, r.hora) - anticipacionMs - ahora; // tiempo que queda para poder confirmar
      if (restante < alertaMs) {
        db.prepare("UPDATE reservas SET alerta_plazo_en = datetime('now') WHERE id = ?").run(r.id);
        enviadas += avisar('plazo_cerca', r.id, {
          restante: restante > 0 ? duracion(restante) : '0 min', limite: (({ fecha, hora }) => `${fecha} ${hora}`)(enBogota(recogidaMs(r.fecha, r.hora) - anticipacionMs)),
        });
      }
    }
  }
  // El conductor asignado no responde dentro del tiempo acordado: se avisa al administrador, una sola vez.
  const conductorMs = ajustes.obtener('sla_conductor_min') * 60000;
  const esperando = db.prepare(`SELECT id, conductor_asignado_en FROM reservas
    WHERE estado = 'pendiente' AND conductor_estado = 'pendiente' AND alerta_conductor_en IS NULL AND conductor_asignado_en IS NOT NULL`).all();
  for (const r of esperando) {
    const espera = ahora - utcMs(r.conductor_asignado_en);
    if (espera > conductorMs) {
      db.prepare("UPDATE reservas SET alerta_conductor_en = datetime('now') WHERE id = ?").run(r.id);
      enviadas += avisar('conductor_sin_respuesta', r.id, { espera: duracion(espera), objetivo: duracion(conductorMs) });
    }
  }
  return enviadas;
}

// La reserva ya no existe: el aviso no lleva a ninguna reserva, solo a la lista del cliente o del conductor.
function avisarEliminada(snap, motivo) {
  const lista = [];
  if (snap.cliente_id) lista.push({ id: snap.cliente_id, idioma: snap.cliente_idioma, url: '/cliente' });
  if (snap.empleado_id && ['pendiente', 'aceptada'].includes(snap.conductor_estado)) {
    const c = db.prepare('SELECT idioma FROM usuarios WHERE id = ?').get(snap.empleado_id);
    lista.push({ id: snap.empleado_id, idioma: c && c.idioma, url: '/empleado' });
  }
  const ins = db.prepare('INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, url, reserva_id) VALUES (?,?,?,?,?,NULL)');
  for (const d of lista) {
    const t = traductor(idiomaDe(d.idioma));
    const vars = { id: snap.id, nota: motivo, destino: snap.destino_final, fecha: snap.fecha, hora: snap.hora || '' };
    const titulo = fmt(t('notif.reserva_eliminada.titulo'), vars);
    const cuerpo = fmt(t('notif.reserva_eliminada.cuerpo'), vars);
    ins.run(d.id, 'reserva_eliminada', titulo, cuerpo, d.url);
    enviarPush(d.id, { titulo, cuerpo, url: d.url, tag: `reserva-${snap.id}`, urgente: false }).catch((e) => console.error('Push:', e.message));
  }
  return lista.length;
}

module.exports = { EVENTOS, avisar, avisarEliminada, enviarPush, revisarAlertas, clavePublica, destinatariosAdmin };
