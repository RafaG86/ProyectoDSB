// Teléfonos internacionales: validación, formato y país/idioma que se deducen del indicativo.
const { parsePhoneNumberFromString } = require('libphonenumber-js');

const PAISES_ES = new Set('AR BO CL CO CR CU DO EC SV GT HN MX NI PA PY PE PR UY VE ES GQ'.split(' '));
const PAISES_PT = new Set('BR PT AO MZ CV GW ST TL'.split(' '));

// Los idiomas del sistema son es/en/pt: el resto del mundo se atiende en inglés.
function idiomaDePais(pais) {
  if (PAISES_ES.has(pais)) return 'es';
  if (PAISES_PT.has(pais)) return 'pt';
  return 'en';
}

// Devuelve { e164, internacional, pais, idioma } o null si no es un número válido con indicativo (+).
// Sin `paisPorDefecto` exige el indicativo (+); con él (p. ej. 'CO') también acepta números nacionales como "300 123 4567".
function analizar(entrada, paisPorDefecto) {
  const crudo = String(entrada ?? '').trim();
  if (!crudo.startsWith('+') && !paisPorDefecto) return null;
  const tel = parsePhoneNumberFromString(crudo, crudo.startsWith('+') ? undefined : paisPorDefecto);
  if (!tel || !tel.isValid()) return null;
  const pais = tel.country || null;
  return { e164: tel.number, internacional: tel.formatInternational(), pais, idioma: idiomaDePais(pais) };
}

module.exports = { analizar, idiomaDePais };
