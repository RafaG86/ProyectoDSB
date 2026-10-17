// Disponibilidad de un conductor para un servicio.
// Un conductor NO está disponible si (1) marcó esas fechas como no disponibles, o (2) ya tiene otro servicio
// activo cuyo horario se cruza. Un servicio ocupa desde la recogida hasta su duración (la del tour, o la
// duración por defecto de los Ajustes en los servicios especiales).
const db = require('../db/database');
const ajustes = require('./ajustes');
const { recogidaMs, enBogota } = require('./tiempo');

const HORA_MS = 3600000;

function ventana(fecha, hora, duracionHrs) {
  const inicio = recogidaMs(fecha, hora);
  return [inicio, inicio + (duracionHrs || ajustes.obtener('duracion_defecto_horas')) * HORA_MS];
}

// reserva: { id, fecha, hora, duracion_hrs }. Se ignora esa misma reserva al buscar cruces.
// Devuelve { libre: true } o { libre: false, motivo: 'no_disponible' | 'ocupado', ... }.
function disponibilidadConductor(conductorId, reserva) {
  const [inicio, fin] = ventana(reserva.fecha, reserva.hora, reserva.duracion_hrs);

  // Días que toca el servicio (un servicio nocturno puede pasar a la fecha siguiente).
  const diaInicio = reserva.fecha;
  const diaFin = enBogota(fin - 1).fecha;
  const fuera = db.prepare(`SELECT desde, hasta, motivo FROM indisponibilidades
                            WHERE usuario_id = ? AND desde <= ? AND hasta >= ? ORDER BY desde LIMIT 1`).get(conductorId, diaFin, diaInicio);
  if (fuera) return { libre: false, motivo: 'no_disponible', desde: fuera.desde, hasta: fuera.hasta, texto: fuera.motivo };

  const otras = db.prepare(`
    SELECT r.id, r.fecha, r.hora, t.duracion_hrs
    FROM reservas r LEFT JOIN tours t ON t.id = r.tour_id
    WHERE r.empleado_id = ? AND r.id != ? AND r.estado IN ('pendiente', 'confirmada')
      AND r.conductor_estado IN ('pendiente', 'aceptada')`).all(conductorId, reserva.id ?? 0);
  for (const o of otras) {
    const [i2, f2] = ventana(o.fecha, o.hora, o.duracion_hrs);
    if (inicio < f2 && i2 < fin) return { libre: false, motivo: 'ocupado', reservaId: o.id, fecha: o.fecha, hora: o.hora };
  }
  return { libre: true };
}

// Servicios activos de un conductor que caen dentro de un rango de fechas (para avisarle de cruces).
function serviciosEnRango(conductorId, desde, hasta) {
  return db.prepare(`
    SELECT r.id, r.fecha, r.hora, t.duracion_hrs
    FROM reservas r LEFT JOIN tours t ON t.id = r.tour_id
    WHERE r.empleado_id = ? AND r.estado IN ('pendiente', 'confirmada') AND r.conductor_estado IN ('pendiente', 'aceptada')`).all(conductorId)
    .filter((r) => { const [, fin] = ventana(r.fecha, r.hora, r.duracion_hrs); return r.fecha <= hasta && enBogota(fin - 1).fecha >= desde; });
}

module.exports = { disponibilidadConductor, serviciosEnRango };
