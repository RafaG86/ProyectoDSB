// Nombre y apellidos juntos, para listados. `alias` es el alias de la tabla usuarios en la consulta.
const nombreCompleto = (alias) => `TRIM(${alias}.nombre || ' ' || COALESCE(${alias}.apellidos, ''))`;

module.exports = { nombreCompleto };
