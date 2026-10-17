// Ajustes del negocio que el administrador puede cambiar (tabla `ajustes`). Si no hay valor, rige el de fábrica.
const db = require('../db/database');

const DEFAULTS = {
  sla_respuesta_min: 60,   // tiempo objetivo para dar la primera respuesta a una solicitud (minutos)
  anticipacion_horas: 24,  // la recogida debe ser al menos N horas después de formalizar (confirmar) la reserva
  alerta_plazo_horas: 3,   // se avisa cuando faltan N horas para el último momento de confirmar
  duracion_defecto_horas: 8, // cuánto dura, para la agenda del conductor, un servicio sin duración conocida (los tours traen la suya)
  sla_conductor_min: 60,   // tiempo para que el conductor asignado responda antes de avisar al administrador (minutos)
};
const LIMITES = { sla_respuesta_min: [1, 1440], anticipacion_horas: [1, 168], alerta_plazo_horas: [1, 72], duracion_defecto_horas: [1, 72], sla_conductor_min: [1, 1440] };

function obtener(clave) {
  const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
  const n = fila ? Number(fila.valor) : NaN;
  return Number.isFinite(n) ? n : DEFAULTS[clave];
}

const todos = () => Object.fromEntries(Object.keys(DEFAULTS).map((c) => [c, obtener(c)]));

function guardar(clave, valor) {
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, String(valor));
}

// Texto crudo (claves VAPID de las notificaciones push).
const leerTexto = (clave) => db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave)?.valor ?? null;

module.exports = { DEFAULTS, LIMITES, obtener, todos, guardar, leerTexto };
