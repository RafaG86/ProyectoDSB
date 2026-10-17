const db = require('../db/database');
const { PERMISOS } = require('../db/permisos');
const { nombreCompleto } = require('../lib/sql');

// El admin tiene siempre todos los permisos; el resto, los que su nivel tenga marcados.
function permisosDeRol(clave) {
  if (clave === 'admin') return new Set(PERMISOS);
  const filas = db.prepare(
    'SELECT rp.permiso FROM rol_permisos rp JOIN roles r ON r.id = rp.rol_id WHERE r.clave = ?'
  ).all(clave);
  return new Set(filas.map((f) => f.permiso));
}

// Se ejecuta en cada petición: relee usuario y nivel desde la base de datos, así que desactivar
// a un usuario o cambiar los permisos de un nivel surte efecto de inmediato, sin esperar a un nuevo login.
function cargarAcceso(req, res, next) {
  let user = null;
  let permisos = new Set();
  const sesion = req.session.user;
  if (sesion) {
    const fila = db.prepare(
      `SELECT u.id, ${nombreCompleto('u')} AS nombre, u.email, u.rol, r.panel FROM usuarios u JOIN roles r ON r.clave = u.rol WHERE u.id = ? AND u.activo = 1`
    ).get(sesion.id);
    if (fila) {
      user = { ...fila };
      req.session.user = user;
      permisos = permisosDeRol(user.rol);
    } else {
      delete req.session.user;
    }
  }
  req.can = (permiso) => permisos.has(permiso);
  res.locals.sinLeer = user
    ? db.prepare('SELECT COUNT(*) n FROM notificaciones WHERE usuario_id = ? AND leida_en IS NULL').get(user.id).n
    : 0;
  res.locals.user = user;
  res.locals.can = req.can;
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// Uso: requirePermission('usuarios.gestionar'). Con varios, basta con tener uno.
function requirePermission(...necesarios) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!necesarios.some((p) => req.can(p))) {
      return res.status(403).render('error', { titulo: req.t('err.denied.title'), mensaje: req.t('err.denied.msg') });
    }
    next();
  };
}

module.exports = { cargarAcceso, requireLogin, requirePermission, permisosDeRol };
