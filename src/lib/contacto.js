// Datos que la página principal muestra al público. Todo viene de los Ajustes: si el admin no lo configuró, no se muestra.
const ajustes = require('./ajustes');
const { analizar } = require('./telefono');

const CONFIANZA = [
  { clave: 'conf_habilitacion', icono: '📄' },
  { clave: 'conf_seguros', icono: '🛡️' },
  { clave: 'conf_calificacion', icono: '⭐' },
];

function datosPublicos() {
  const wa = analizar(ajustes.leerTexto('whatsapp_numero') || '', 'CO');
  return {
    whatsapp: wa ? { digitos: wa.e164.replace('+', ''), formato: wa.internacional } : null,
    horario: (ajustes.leerTexto('horario_atencion') || '').trim(),
    confianza: CONFIANZA.map((c) => ({ icono: c.icono, texto: (ajustes.leerTexto(c.clave) || '').trim() })).filter((c) => c.texto),
  };
}

// Solo rutas internas: evita que "next" lleve a otro sitio (redirección abierta).
const rutaSegura = (v) => (typeof v === 'string' && v.length < 300 && /^\/(?![/\\])[^\r\n]*$/.test(v) ? v : '');

module.exports = { datosPublicos, rutaSegura };
