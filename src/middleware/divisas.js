const router = require('express').Router();
const { ORDEN, obtenerDivisas, convertir } = require('../lib/divisas');
const { formatear, LOCALES } = require('../lib/dinero');

const COOKIE = 'divisa';
const DEFAULT = 'USD';

// Moneda en que cada visitante quiere ver los precios de lista: cookie elegida > USD.
// Deja en las vistas: money(), aprox(), precioLista(), divisaVista, listaDivisas y divisas.
// Debe ir DESPUÉS del middleware de idiomas (usa res.locals.lang).
function middleware(req, res, next) {
  const divisas = obtenerDivisas();
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Z]{3})'));
  const vista = m && divisas[m[1]] ? m[1] : DEFAULT;
  const lang = res.locals.lang;

  const money = (monto, codigo, preciso = false) => {
    const d = divisas[codigo] || divisas[DEFAULT];
    return formatear(monto, d.codigo, d.decimales, lang, preciso);
  };
  const convertido = (monto, codigo) => money(convertir(monto, codigo, vista, divisas), vista);

  req.divisas = divisas;
  res.locals.divisas = divisas;
  res.locals.divisaVista = vista;
  res.locals.listaDivisas = ORDEN.filter((c) => divisas[c]);
  res.locals.localeJs = LOCALES[lang] || LOCALES.es;
  res.locals.money = money;
  // Equivalencia aproximada en la moneda elegida ("" si ya está en esa moneda).
  res.locals.aprox = (monto, codigo) => (codigo === vista ? '' : '≈ ' + convertido(monto, codigo));
  // Precio de lista (tours): en la moneda elegida, con ≈ si hubo que convertir.
  res.locals.precioLista = (monto, codigo) => (codigo === vista ? money(monto, codigo) : '≈ ' + convertido(monto, codigo));
  next();
}

// GET /divisa/EUR?next=/
router.get('/divisa/:code', (req, res) => {
  if (obtenerDivisas()[req.params.code]) {
    res.cookie(COOKIE, req.params.code, { maxAge: 1000 * 60 * 60 * 24 * 365, sameSite: 'lax', path: '/' });
  }
  const next = String(req.query.next || '/');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

module.exports = { middleware, router };
