// Cotización de un servicio: transporte (km × tarifa, con mínimo) + peajes + viáticos del conductor.
// Todo en la moneda de la cotización; `decimales` es el de esa moneda (COP 0, USD/EUR 2).
const { redondear } = require('./dinero');

function calcular({ km, precio_km, minimo = 0, peajes = 0, viaticos = 0, decimales = 2 }) {
  const porKm = redondear(km * precio_km, decimales);
  const min = redondear(minimo || 0, decimales);
  const transporte = Math.max(porKm, min);
  return {
    transporte,
    minimoAplicado: porKm < min,
    total: redondear(transporte + peajes + viaticos, decimales),
  };
}

module.exports = { calcular };
