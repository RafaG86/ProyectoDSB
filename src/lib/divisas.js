const db = require('../db/database');

const ORDEN = ['USD', 'EUR', 'COP']; // orden en que se muestran las monedas

// { USD: { codigo, decimales, tasa, ... }, EUR: ..., COP: ... }. `tasa` = unidades de esa moneda por 1 USD.
function obtenerDivisas() {
  const mapa = {};
  for (const d of db.prepare('SELECT * FROM divisas').all()) mapa[d.codigo] = d;
  return mapa;
}

function convertir(monto, de, a, divisas) {
  return (monto / divisas[de].tasa) * divisas[a].tasa;
}

module.exports = { ORDEN, obtenerDivisas, convertir };
