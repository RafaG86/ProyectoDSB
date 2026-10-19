const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ROLES_SISTEMA } = require('./permisos');

const dataDir = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// DB_PATH permite usar otra base (p. ej. una temporal para pruebas) sin tocar la de verdad.
const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'dsb.db'));
db.exec('PRAGMA busy_timeout = 5000'); // si otro proceso está escribiendo, espera en vez de fallar al instante
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Niveles de fábrica. Sus permisos se cargan solo al crearlos, para no pisar lo que el admin cambie después.
const insRol = db.prepare('INSERT OR IGNORE INTO roles (clave, nombre, panel, es_sistema) VALUES (?,?,?,1)');
const insPerm = db.prepare('INSERT OR IGNORE INTO rol_permisos (rol_id, permiso) SELECT id, ? FROM roles WHERE clave = ?');
for (const r of ROLES_SISTEMA) {
  if (insRol.run(r.clave, r.nombre, r.panel).changes) {
    for (const p of r.permisos) insPerm.run(p, r.clave);
  }
}

// Recrea una tabla con otro esquema conservando sus filas (receta oficial de SQLite para ALTER complejos).
function recrearTabla(sqlNueva, nombre, columnasCopiadas) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(sqlNueva);
    db.exec(`INSERT INTO ${nombre}_nueva (${columnasCopiadas}) SELECT ${columnasCopiadas} FROM ${nombre}`);
    db.exec(`DROP TABLE ${nombre}`);
    db.exec(`ALTER TABLE ${nombre}_nueva RENAME TO ${nombre}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const sqlDe = (tabla) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tabla)?.sql || '';

// Migración 1: `usuarios` limitaba el rol a 3 valores fijos (CHECK); ahora apunta a la tabla `roles`.
if (/CHECK\s*\(\s*rol\s+IN/i.test(sqlDe('usuarios'))) {
  recrearTabla(`
    CREATE TABLE usuarios_nueva (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre        TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol           TEXT NOT NULL REFERENCES roles(clave),
      telefono      TEXT,
      activo        INTEGER NOT NULL DEFAULT 1,
      creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
    )`, 'usuarios', 'id, nombre, email, password_hash, rol, telefono, activo, creado_en');
}

// Migración 2: `reservas` gana hora, recogida, destino propio y servicios "especiales" (sin tour).
if (!/\btipo\b/.test(sqlDe('reservas'))) {
  recrearTabla(`
    CREATE TABLE reservas_nueva (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id     INTEGER NOT NULL REFERENCES usuarios(id),
      tipo           TEXT NOT NULL DEFAULT 'tour' CHECK (tipo IN ('tour','especial')),
      tour_id        INTEGER REFERENCES tours(id),
      empleado_id    INTEGER REFERENCES usuarios(id),
      vehiculo_id    INTEGER REFERENCES vehiculos(id),
      fecha          TEXT NOT NULL,
      hora           TEXT,
      punto_recogida TEXT,
      destino        TEXT,
      pasajeros      INTEGER NOT NULL DEFAULT 1,
      estado         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','confirmada','completada','cancelada')),
      notas          TEXT,
      creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((tipo = 'tour' AND tour_id IS NOT NULL) OR (tipo = 'especial' AND destino IS NOT NULL))
    )`, 'reservas', 'id, cliente_id, tour_id, empleado_id, vehiculo_id, fecha, pasajeros, estado, notas, creado_en');
}

// Añade las columnas que falten a una tabla ya existente (bases creadas antes de cada función).
function agregarColumnas(tabla, columnas) {
  const existentes = new Set(db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name));
  for (const [col, def] of columnas) {
    if (!existentes.has(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
  }
}

// Migración 3: columnas de cotización en `reservas` (tarifario por kilómetro).
agregarColumnas('reservas', [['tarifa_nombre', 'TEXT'], ['precio_km', 'REAL'], ['tarifa_minima', 'REAL'], ['km', 'REAL'],
  ['peajes', 'REAL'], ['viaticos', 'REAL'], ['total', 'REAL'], ['cotizado_en', 'TEXT']]);

// Migración 5: divisas. Todo lo anterior estaba en dólares, así que las cotizaciones y tarifas existentes quedan en USD.
agregarColumnas('reservas', [['moneda_solicitada', 'TEXT'], ['moneda', 'TEXT'], ['tarifa_moneda', 'TEXT'], ['factor', 'REAL']]);
agregarColumnas('tarifas', [['moneda', "TEXT NOT NULL DEFAULT 'USD'"]]);
agregarColumnas('tours', [['moneda', "TEXT NOT NULL DEFAULT 'USD'"]]);
// Migración 6: datos de contacto internacionales y condiciones especiales (mascotas, niños) de la reserva.
agregarColumnas('usuarios', [['apellidos', 'TEXT'], ['pais', 'TEXT'], ['idioma', 'TEXT']]);
agregarColumnas('reservas', [
  ['origen', "TEXT NOT NULL DEFAULT 'Bogotá'"],
  ['lleva_mascotas', 'INTEGER NOT NULL DEFAULT 0'], ['mascotas_detalle', 'TEXT'],
  ['lleva_ninos', 'INTEGER NOT NULL DEFAULT 0'], ['ninos_detalle', 'TEXT'],
  ['autorizacion', "TEXT NOT NULL DEFAULT 'no_requiere' CHECK (autorizacion IN ('no_requiere','pendiente','autorizada','rechazada'))"],
  ['autorizacion_nota', 'TEXT'], ['autorizado_en', 'TEXT'],
]);

// Migración 7: tiempos de atención de la reserva (respuesta, formalización y alertas).
agregarColumnas('reservas', [['primera_respuesta_en', 'TEXT'], ['confirmada_en', 'TEXT'], ['alerta_sla_en', 'TEXT'], ['alerta_plazo_en', 'TEXT']]);

// Migración 8: confirmación del conductor. Las reservas que ya tenían conductor asignado antes de existir
// este paso se dejan como "aceptadas", para que no queden bloqueadas.
const teniaConductor = new Set(db.prepare('PRAGMA table_info(reservas)').all().map((c) => c.name)).has('conductor_estado');
agregarColumnas('reservas', [
  ['conductor_estado', "TEXT NOT NULL DEFAULT 'sin_asignar' CHECK (conductor_estado IN ('sin_asignar','pendiente','aceptada','rechazada'))"],
  ['conductor_asignado_en', 'TEXT'], ['conductor_respondido_en', 'TEXT'], ['conductor_nota', 'TEXT'], ['alerta_conductor_en', 'TEXT'],
]);
if (!teniaConductor) db.exec("UPDATE reservas SET conductor_estado = 'aceptada' WHERE empleado_id IS NOT NULL");

// Migración 10: pago simulado por Nequi.
agregarColumnas('reservas', [
  ['pago_estado', "TEXT NOT NULL DEFAULT 'sin_pago' CHECK (pago_estado IN ('sin_pago','en_revision','confirmado','rechazado'))"],
  ['pago_codigo', 'TEXT'], ['pago_monto_cop', 'INTEGER'], ['pago_nequi_cliente', 'TEXT'], ['pago_referencia', 'TEXT'],
  ['pago_evidencia', 'TEXT'], ['pago_evidencia_tipo', 'TEXT'], ['pago_hash', 'TEXT'],
  ['pago_enviado_en', 'TEXT'], ['pago_revisado_en', 'TEXT'], ['pago_nota', 'TEXT'],
]);

db.exec("UPDATE reservas SET moneda = 'USD', tarifa_moneda = 'USD', factor = 1 WHERE total IS NOT NULL AND moneda IS NULL");

// Tasas iniciales (ILUSTRATIVAS: el admin las ajusta en Divisas). Solo se cargan si no existen.
const insDivisa = db.prepare('INSERT OR IGNORE INTO divisas (codigo, nombre, decimales, tasa) VALUES (?,?,?,?)');
insDivisa.run('USD', 'Dólar estadounidense', 2, 1);
insDivisa.run('EUR', 'Euro', 2, 0.92);
insDivisa.run('COP', 'Peso colombiano', 0, 4000);

// Cuenta Nequi de la empresa: de SIMULACIÓN mientras el pago sea simulado. Solo se carga si nunca se ha configurado
// (si el administrador la cambia, o la deja vacía a propósito, no se vuelve a poner).
const insAjuste = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
insAjuste.run('nequi_numero', '3000000000');
insAjuste.run('nequi_titular', 'DSB Transportes (simulación)');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reservas_cliente  ON reservas(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_reservas_empleado ON reservas(empleado_id);
`);

// Migración 4 (user_version 2): el nivel Cliente puede cancelar sus reservas. Se concede una sola vez,
// para que, si el admin se lo quita después, no se vuelva a poner en cada arranque.
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  insPerm.run('reservas.cancelar_propia', 'cliente');
  db.exec('PRAGMA user_version = 2');
}

// Migración 9 (user_version 3): el nivel Empleado puede responder a los servicios que le asignan
// y declarar sus fechas no disponibles. Se concede una sola vez, para no pisar cambios posteriores del admin.
if (db.prepare('PRAGMA user_version').get().user_version < 3) {
  insPerm.run('servicios.responder', 'empleado');
  insPerm.run('disponibilidad.gestionar', 'empleado');
  db.exec('PRAGMA user_version = 3');
}

// Migración 11 (user_version 4): el nivel Cliente puede pagar sus reservas.
if (db.prepare('PRAGMA user_version').get().user_version < 4) {
  insPerm.run('pagos.realizar', 'cliente');
  db.exec('PRAGMA user_version = 4');
}

module.exports = db;
