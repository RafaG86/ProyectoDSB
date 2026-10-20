// Catálogo de permisos del sistema. Cada permiso se traduce con la clave i18n 'perm.<permiso>'.
// Para proteger una ruta nueva: añade el permiso aquí, sus textos en src/i18n/*.js y usa requirePermission('...').
const PERMISOS = [
  'panel.admin',
  'usuarios.gestionar',
  'reservas.ver_todas',
  'roles.gestionar',
  'servicios.ver_asignados',
  'reservas.crear_propia',
  'reservas.ver_propias',
  'reservas.cancelar_propia',
  'reservas.gestionar',
  'tarifas.gestionar',
  'divisas.gestionar',
  'ajustes.gestionar',
  'servicios.responder',
  'disponibilidad.gestionar',
  'pagos.realizar',
  'pagos.verificar',
  'reservas.eliminar',
  'contactos.gestionar',
];

// Panel (página de inicio) al que entra cada nivel.
const PANELES = ['admin', 'empleado', 'cliente'];
const HOME = { admin: '/admin', empleado: '/empleado', cliente: '/cliente' };

// Niveles que vienen de fábrica. 'admin' siempre tiene todos los permisos y no se puede editar.
const ROLES_SISTEMA = [
  { clave: 'admin', nombre: 'Administrador', panel: 'admin', permisos: PERMISOS },
  { clave: 'empleado', nombre: 'Empleado', panel: 'empleado', permisos: ['servicios.ver_asignados', 'servicios.responder', 'disponibilidad.gestionar'] },
  { clave: 'cliente', nombre: 'Cliente', panel: 'cliente', permisos: ['reservas.crear_propia', 'reservas.ver_propias', 'reservas.cancelar_propia', 'pagos.realizar'] },
];

module.exports = { PERMISOS, PANELES, HOME, ROLES_SISTEMA };
