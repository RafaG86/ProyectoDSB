const router = require('express').Router();

const locales = { es: require('./es'), en: require('./en'), pt: require('./pt') };
const DEFAULT = 'es';
const COOKIE = 'lang';

function fromCookie(header = '') {
  const m = header.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-z]{2})'));
  return m && locales[m[1]] ? m[1] : null;
}

function fromAcceptLanguage(header = '') {
  for (const part of header.split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (locales[code]) return code;
  }
  return null;
}

// Idioma: cookie elegida por el usuario > idioma del navegador > español.
function middleware(req, res, next) {
  const lang = fromCookie(req.headers.cookie) || fromAcceptLanguage(req.headers['accept-language']) || DEFAULT;
  const dict = locales[lang];
  const t = (key) => dict[key] ?? locales[DEFAULT][key] ?? key;
  req.t = t;
  res.locals.t = t;
  res.locals.lang = lang;
  // Nombre de un nivel: los de fábrica se traducen; los creados por el admin muestran su nombre tal cual.
  res.locals.rolNombre = (r) => (r.es_sistema ? t('rol.' + r.clave) : r.nombre);
  const regiones = new Intl.DisplayNames([lang], { type: 'region' });
  res.locals.paisNombre = (codigo) => { try { return codigo ? regiones.of(codigo) : '—'; } catch (e) { return codigo || '—'; } };
  res.locals.languages = Object.keys(locales).map((code) => ({ code, name: locales[code]['lang.name'] }));
  res.locals.currentPath = req.originalUrl;
  next();
}

// GET /lang/en?next=/login
router.get('/lang/:code', (req, res) => {
  if (locales[req.params.code]) {
    res.cookie(COOKIE, req.params.code, { maxAge: 1000 * 60 * 60 * 24 * 365, sameSite: 'lax', path: '/' });
  }
  const next = String(req.query.next || '/');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

// Si la persona aún no ha elegido idioma (cookie), se le deja el que corresponde a su país.
function recordarIdioma(req, res, idioma) {
  if (!locales[idioma] || fromCookie(req.headers.cookie)) return;
  res.cookie(COOKIE, idioma, { maxAge: 1000 * 60 * 60 * 24 * 365, sameSite: 'lax', path: '/' });
}

// Traductor para textos que se generan fuera de una petición (p. ej. avisos al celular): traductor('en')('clave').
function traductor(lang) {
  const dict = locales[lang] || locales[DEFAULT];
  return (key) => dict[key] ?? locales[DEFAULT][key] ?? key;
}

module.exports = { middleware, router, recordarIdioma, traductor };
