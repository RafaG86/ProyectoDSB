const { textoBogota, duracion, utcMs } = require('../lib/tiempo');

// Para las vistas: horas en hora de Bogotá y duraciones legibles.
//   bogota('2026-10-20 15:00:00')  ->  '2026-10-20 10:00'   (los textos de SQLite están en UTC)
//   duracion(ms)                   ->  '2 h 10 min'
function middleware(req, res, next) {
  res.locals.bogota = textoBogota;
  res.locals.duracion = duracion;
  res.locals.utcMs = utcMs;
  next();
}

module.exports = { middleware };
