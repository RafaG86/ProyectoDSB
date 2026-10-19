// Pago SIMULADO por Nequi: la empresa tiene un número Nequi; el cliente paga en pesos colombianos, declara su propio
// número y la referencia del comprobante y sube la evidencia; el administrador la verifica y, al confirmarla,
// la reserva queda confirmada. No se conecta con Nequi ni mueve dinero real.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const ajustes = require('./ajustes');
const { convertir } = require('./divisas');
const { recogidaMs } = require('./tiempo');

// Las evidencias se guardan junto a la base de datos (data/evidencias), nunca en la carpeta pública.
const DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', '..', 'data'), 'evidencias');
fs.mkdirSync(DIR, { recursive: true });

const MAX_BYTES = 5 * 1024 * 1024;

// Celular colombiano de 10 dígitos que empieza por 3 (los que tienen Nequi). Devuelve los 10 dígitos o null.
function nequiValido(texto) {
  const t = parsePhoneNumberFromString(String(texto ?? '').trim(), 'CO');
  if (!t || !t.isValid() || t.country !== 'CO') return null;
  return /^3\d{9}$/.test(t.nationalNumber) ? t.nationalNumber : null;
}

const nequiEmpresa = () => ({ numero: ajustes.leerTexto('nequi_numero') || '', titular: ajustes.leerTexto('nequi_titular') || '' });

// Nequi solo mueve pesos colombianos: la cotización se convierte a COP con la tasa del momento.
function montoCOP(reserva, divisas) {
  if (reserva.total == null) return null;
  return Math.round(convertir(reserva.total, reserva.moneda || 'USD', 'COP', divisas));
}

// Lo que debe cumplirse antes de que el cliente pueda pagar (todo menos el pago, que es lo que confirma la reserva).
function requisitosPago(r) {
  const horas = ajustes.obtener('anticipacion_horas');
  const faltan = [];
  if (r.total == null) faltan.push('quote');
  if (r.autorizacion === 'pendiente' || r.autorizacion === 'rechazada') faltan.push('auth');
  if (!r.empleado_id || r.conductor_estado !== 'aceptada') faltan.push('driver');
  if (recogidaMs(r.fecha, r.hora) < Date.now() + horas * 3600000) faltan.push('lead');
  return { ok: faltan.length === 0, faltan, horas };
}

// Código que el cliente escribe en el mensaje de la transferencia: une la transferencia con esta reserva.
function codigoPago(reservaId) {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para que no se confundan
  let s = '';
  for (const b of crypto.randomBytes(4)) s += alfabeto[b % alfabeto.length];
  return `DSB-${reservaId}-${s}`;
}

// Tipo REAL del archivo, por sus primeros bytes (el nombre y el tipo que declara el navegador no son de fiar).
function tipoArchivo(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { tipo: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { tipo: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { tipo: 'image/webp', ext: 'webp' };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { tipo: 'application/pdf', ext: 'pdf' };
  return null;
}

function guardarEvidencia(buf) {
  const info = tipoArchivo(buf);
  if (!info) return null;
  const nombre = `${crypto.randomBytes(16).toString('hex')}.${info.ext}`;
  fs.writeFileSync(path.join(DIR, nombre), buf);
  return { nombre, tipo: info.tipo, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}

const NOMBRE_VALIDO = /^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;

function rutaEvidencia(nombre) {
  return NOMBRE_VALIDO.test(String(nombre)) ? path.join(DIR, nombre) : null; // impide salirse de la carpeta
}

function borrarEvidencia(nombre) {
  const ruta = rutaEvidencia(nombre);
  if (ruta) fs.rmSync(ruta, { force: true });
}

// Envía la evidencia al navegador solo a quien ya fue autorizado por la ruta.
function enviarEvidencia(res, reserva) {
  const ruta = rutaEvidencia(reserva.pago_evidencia);
  if (!ruta || !fs.existsSync(ruta)) return res.status(404).end();
  res.set({
    'Content-Type': reserva.pago_evidencia_tipo,
    'Content-Disposition': `inline; filename="comprobante-${reserva.id}.${reserva.pago_evidencia.split('.').pop()}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  });
  return res.sendFile(ruta);
}

module.exports = { MAX_BYTES, nequiValido, nequiEmpresa, montoCOP, requisitosPago, codigoPago, guardarEvidencia, borrarEvidencia, enviarEvidencia };
