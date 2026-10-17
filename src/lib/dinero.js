// Utilidades de dinero sin acceso a la base de datos (se pueden usar en cualquier parte).
const LOCALES = { es: 'es-CO', en: 'en-US', pt: 'pt-BR' };
const formateadores = new Map();

function redondear(n, decimales) {
  const f = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * f) / f;
}

// "COP 650.000", "USD 1,200.00". Se muestra siempre el código, porque "$" sirve para dólar y peso a la vez.
// `preciso` deja más decimales (para precios por km, p. ej. EUR 1.104).
function formatear(n, codigo, decimales, lang, preciso = false) {
  const max = preciso ? (decimales === 0 ? 2 : 4) : decimales;
  const clave = `${lang}|${codigo}|${decimales}|${max}`;
  let f = formateadores.get(clave);
  if (!f) {
    f = new Intl.NumberFormat(LOCALES[lang] || LOCALES.es, {
      style: 'currency', currency: codigo, currencyDisplay: 'code',
      minimumFractionDigits: decimales, maximumFractionDigits: max,
    });
    formateadores.set(clave, f);
  }
  return f.format(n);
}

module.exports = { LOCALES, redondear, formatear };
