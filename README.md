# DSB Transportes Especiales

Sistema web para una empresa de transporte especial y turismo: landing, reservas, paneles por nivel de acceso
(administrador, empleado/conductor, cliente), cotización por kilómetro, divisas, avisos y notificaciones en el celular.

## Requisitos

- Node.js 22.13 o superior (usa el SQLite incluido en Node; no hay que instalar una base de datos).

## Puesta en marcha

```bash
npm install
npm run seed      # crea la base de datos (data/dsb.db) con usuarios, tours y tarifas de ejemplo
npm run dev       # http://localhost:3000  (se reinicia solo al guardar cambios)
```

Usuarios de demostración (**cámbialos antes de publicar**):

| Nivel | Correo | Contraseña |
|---|---|---|
| Administrador | admin@dsb.com | Admin123! |
| Empleado (conductor) | empleado@dsb.com | Empleado123! |
| Cliente | cliente@dsb.com | Cliente123! |

## Variables de entorno

| Variable | Para qué sirve |
|---|---|
| `PORT` | Puerto del servidor (3000 por defecto). |
| `SESSION_SECRET` | Secreto de las sesiones. **Obligatorio cambiarlo en producción.** |
| `VAPID_SUBJECT` | Correo de contacto de la empresa para las notificaciones push, con formato `mailto:correo@dominio.com`. |
| `DB_PATH` | Ruta de otra base de datos (útil para pruebas). |

## Notas importantes

- **Notificaciones en el celular:** solo funcionan con **HTTPS** (o en `localhost`). En iPhone, la app debe estar
  instalada en la pantalla de inicio.
- **Respaldos:** toda la información está en `data/dsb.db`. Ese archivo no se sube al repositorio; hay que
  respaldarlo aparte.
- **Pendiente antes de producción:** protección CSRF en los formularios, cambiar las contraseñas de demostración y
  poner un `SESSION_SECRET` propio.

El flujo completo del proceso está en [DIAGRAMA-FLUJO.md](DIAGRAMA-FLUJO.md).
