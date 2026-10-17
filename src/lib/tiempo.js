// La empresa opera desde Bogotá: "hoy" y "ahora" se miden en hora de Bogotá, no en la del servidor.
const ZONA = 'America/Bogota';
const OFFSET = '-05:00'; // Colombia no tiene horario de verano
const formato = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// { fecha: 'AAAA-MM-DD', hora: 'HH:MM' } de un instante (por defecto, ahora) en hora de Bogotá.
function enBogota(ms = Date.now()) {
  const p = Object.fromEntries(formato.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

const ahoraBogota = () => enBogota();
const hoyBogota = () => enBogota().fecha;

// Instante (ms) de una recogida guardada como fecha + hora de Bogotá.
const recogidaMs = (fecha, hora) => Date.parse(`${fecha}T${hora || '00:00'}:00${OFFSET}`);

// Instante (ms) de un texto 'AAAA-MM-DD HH:MM:SS' que SQLite guarda en UTC (datetime('now')).
const utcMs = (texto) => Date.parse(String(texto).replace(' ', 'T') + 'Z');

// 'AAAA-MM-DD HH:MM' en hora de Bogotá, a partir de ms o de un texto UTC de SQLite.
function textoBogota(valor) {
  const ms = typeof valor === 'number' ? valor : utcMs(valor);
  if (!Number.isFinite(ms)) return '—';
  const { fecha, hora } = enBogota(ms);
  return `${fecha} ${hora}`;
}

// Duración legible con dos unidades como máximo: "5 min", "2 h 10 min", "1 d 3 h". (d/h/min valen en es, en y pt)
function duracion(ms) {
  let m = Math.floor(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440); m %= 1440;
  const h = Math.floor(m / 60); m %= 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min` : '< 1 min';
}

module.exports = { ZONA, enBogota, ahoraBogota, hoyBogota, recogidaMs, utcMs, textoBogota, duracion };
