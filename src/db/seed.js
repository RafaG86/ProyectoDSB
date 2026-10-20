const bcrypt = require('bcryptjs');
const db = require('./database');
const { analizar } = require('../lib/telefono');

// [nombre, apellidos, correo, contraseña, rol, teléfono internacional]
const usuarios = [
  ['Administrador', 'DSB', 'admin@dsb.com', 'Admin123!', 'admin', null],
  ['Empleado', 'Demo', 'empleado@dsb.com', 'Empleado123!', 'empleado', null],
  ['Cliente', 'Demo', 'cliente@dsb.com', 'Cliente123!', 'cliente', '+573001234567'],
];

const insU = db.prepare(
  'INSERT OR IGNORE INTO usuarios (nombre, apellidos, email, password_hash, rol, telefono, pais, idioma) VALUES (?,?,?,?,?,?,?,?)'
);
// Cuentas de demostración que se crearon antes de existir apellidos y teléfono: se completan una sola vez.
const completar = db.prepare(
  'UPDATE usuarios SET nombre = ?, apellidos = ?, telefono = ?, pais = ?, idioma = ? WHERE email = ? AND apellidos IS NULL'
);
for (const [nombre, apellidos, email, pass, rol, telefono] of usuarios) {
  const tel = telefono ? analizar(telefono) : null;
  const datos = [tel ? tel.e164 : null, tel ? tel.pais : null, tel ? tel.idioma : null];
  insU.run(nombre, apellidos, email, bcrypt.hashSync(pass, 10), rol, ...datos);
  completar.run(nombre, apellidos, ...datos, email);
}

const insT = db.prepare(
  "INSERT INTO tours (nombre, descripcion, destino, duracion_hrs, precio, moneda) SELECT ?,?,?,?,?,'COP' WHERE NOT EXISTS (SELECT 1 FROM tours WHERE nombre = ?)"
);
const tours = [
  ['City Tour', 'Recorrido por los puntos emblemáticos de la ciudad.', 'Centro histórico', 4, 100000],
  ['Ruta de la Costa', 'Traslado y paseo por las playas de la región.', 'Costa', 8, 240000],
  ['Aventura en Montaña', 'Excursión con transporte y guía.', 'Sierra', 10, 340000],
];
for (const t of tours) insT.run(...t, t[0]);

// Tarifas de ejemplo (valores ilustrativos): se ajustan desde el panel, en "Tarifario".
const insTarifa = db.prepare(
  'INSERT INTO tarifas (nombre, precio_km, tarifa_minima) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM tarifas WHERE nombre = ?)'
);
for (const [nombre, precio, minimo] of [['Automóvil (hasta 4 pax)', 0.8, 15], ['Van (hasta 12 pax)', 1.2, 25], ['Bus (hasta 40 pax)', 2.5, 60]]) {
  insTarifa.run(nombre, precio, minimo, nombre);
}

db.prepare(
  'INSERT OR IGNORE INTO vehiculos (placa, tipo, capacidad) VALUES (?,?,?)'
).run('ABC-123', 'van', 12);

console.log('Datos iniciales cargados.');
console.log('  admin@dsb.com / Admin123!');
console.log('  empleado@dsb.com / Empleado123!');
console.log('  cliente@dsb.com / Cliente123!');
