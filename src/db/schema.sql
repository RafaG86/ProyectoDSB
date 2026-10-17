PRAGMA foreign_keys = ON;

-- Niveles de acceso. 'panel' = página de inicio a la que entra el nivel.
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clave       TEXT NOT NULL UNIQUE,
  nombre      TEXT NOT NULL,
  panel       TEXT NOT NULL CHECK (panel IN ('admin','empleado','cliente')),
  es_sistema  INTEGER NOT NULL DEFAULT 0
);

-- Permisos concedidos a cada nivel (las claves válidas están en permisos.js).
CREATE TABLE IF NOT EXISTS rol_permisos (
  rol_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permiso  TEXT NOT NULL,
  PRIMARY KEY (rol_id, permiso)
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre        TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           TEXT NOT NULL REFERENCES roles(clave),
  apellidos     TEXT,
  telefono      TEXT,                          -- internacional, formato E.164 (+573001234567)
  pais          TEXT,                          -- ISO-2, deducido del indicativo del teléfono
  idioma        TEXT,                          -- es/en/pt, deducido del país
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehiculos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  placa      TEXT NOT NULL UNIQUE,
  tipo       TEXT NOT NULL,              -- bus, van, minivan, etc.
  capacidad  INTEGER NOT NULL,
  estado     TEXT NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','en_ruta','mantenimiento'))
);

CREATE TABLE IF NOT EXISTS tours (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre       TEXT NOT NULL,
  descripcion  TEXT,
  destino      TEXT NOT NULL,
  duracion_hrs INTEGER,
  precio       REAL NOT NULL,
  moneda       TEXT NOT NULL DEFAULT 'USD',
  activo       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reservas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id     INTEGER NOT NULL REFERENCES usuarios(id),
  tipo           TEXT NOT NULL DEFAULT 'tour' CHECK (tipo IN ('tour','especial')),
  tour_id        INTEGER REFERENCES tours(id),            -- solo en tipo 'tour'
  empleado_id    INTEGER REFERENCES usuarios(id),         -- conductor/guía asignado
  vehiculo_id    INTEGER REFERENCES vehiculos(id),
  fecha          TEXT NOT NULL,                           -- AAAA-MM-DD
  hora           TEXT,                                    -- HH:MM
  punto_recogida TEXT,
  destino        TEXT,                                    -- solo en tipo 'especial' (en 'tour' sale del tour)
  pasajeros      INTEGER NOT NULL DEFAULT 1,
  estado         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','confirmada','completada','cancelada')),
  notas          TEXT,
  creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Cotización (NULL = aún sin cotizar). Se guarda una copia de la tarifa usada, para que cambiar el
  -- tarifario después no altere cotizaciones ya hechas.
  tarifa_nombre  TEXT,
  precio_km      REAL,
  tarifa_minima  REAL,
  km             REAL,
  peajes         REAL,
  viaticos       REAL,
  total          REAL,
  cotizado_en    TEXT,
  moneda_solicitada TEXT,                                 -- moneda en que el cliente quiere la cotización
  moneda         TEXT,                                    -- moneda de la cotización (NULL = sin cotizar)
  tarifa_moneda  TEXT,                                    -- moneda original de la tarifa usada
  factor         REAL,                                    -- conversión tarifa -> moneda de la cotización
  origen         TEXT NOT NULL DEFAULT 'Bogotá',          -- por ahora el servicio solo sale de Bogotá
  lleva_mascotas INTEGER NOT NULL DEFAULT 0,
  mascotas_detalle TEXT,
  lleva_ninos    INTEGER NOT NULL DEFAULT 0,
  ninos_detalle  TEXT,
  -- Con mascotas o niños el transporte debe ser autorizado por la empresa antes de confirmar.
  autorizacion   TEXT NOT NULL DEFAULT 'no_requiere' CHECK (autorizacion IN ('no_requiere','pendiente','autorizada','rechazada')),
  autorizacion_nota TEXT,
  autorizado_en  TEXT,
  -- Tiempos de atención (UTC). La recogida debe ser >= N horas después de confirmar (ajuste 'anticipacion_horas').
  primera_respuesta_en TEXT,                             -- primera acción del equipo (cotizar, autorizar, cancelar...)
  confirmada_en  TEXT,                                    -- cuándo se formalizó (confirmó) la reserva
  alerta_sla_en  TEXT,                                    -- ya se avisó que pasó el tiempo objetivo de respuesta
  alerta_plazo_en TEXT,                                   -- ya se avisó que se acaba el plazo para confirmar
  -- Confirmación del conductor: la reserva solo puede confirmarse si el conductor asignado la aceptó.
  conductor_estado TEXT NOT NULL DEFAULT 'sin_asignar' CHECK (conductor_estado IN ('sin_asignar','pendiente','aceptada','rechazada')),
  conductor_asignado_en TEXT,
  conductor_respondido_en TEXT,
  conductor_nota TEXT,                                    -- motivo cuando el conductor no puede
  alerta_conductor_en TEXT,                               -- ya se avisó que el conductor no responde
  CHECK ((tipo = 'tour' AND tour_id IS NOT NULL) OR (tipo = 'especial' AND destino IS NOT NULL))
);

-- Tarifario por kilómetro. 'tarifa_minima' = cobro mínimo del transporte (sin peajes ni viáticos).
CREATE TABLE IF NOT EXISTS tarifas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre        TEXT NOT NULL,
  precio_km     REAL NOT NULL CHECK (precio_km > 0),
  tarifa_minima REAL NOT NULL DEFAULT 0 CHECK (tarifa_minima >= 0),
  moneda        TEXT NOT NULL DEFAULT 'USD',
  activo        INTEGER NOT NULL DEFAULT 1
);

-- Divisas. `tasa` = unidades de la moneda por 1 USD (USD siempre 1). El admin las actualiza a mano.
CREATE TABLE IF NOT EXISTS divisas (
  codigo        TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  decimales     INTEGER NOT NULL,
  tasa          REAL NOT NULL CHECK (tasa > 0),
  actualizada_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ajustes del sistema (tiempos objetivo, anticipación mínima) y claves VAPID de las notificaciones push.
CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- Avisos dentro de la app (campana). También se envían como notificación push si el usuario la activó.
CREATE TABLE IF NOT EXISTS notificaciones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL,
  titulo      TEXT NOT NULL,
  cuerpo      TEXT,
  url         TEXT,
  reserva_id  INTEGER,
  creada_en   TEXT NOT NULL DEFAULT (datetime('now')),
  leida_en    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_usuario ON notificaciones(usuario_id, leida_en);

-- Dispositivos (navegador o app instalada) de cada usuario que activaron las notificaciones push.
CREATE TABLE IF NOT EXISTS suscripciones_push (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  agente      TEXT,
  creada_en   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fechas en que un conductor NO puede trabajar (vacaciones, permisos...). Rango inclusivo, en fechas de Bogotá.
CREATE TABLE IF NOT EXISTS indisponibilidades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  desde       TEXT NOT NULL,
  hasta       TEXT NOT NULL,
  motivo      TEXT,
  creada_en   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (hasta >= desde)
);
CREATE INDEX IF NOT EXISTS idx_indisp_usuario ON indisponibilidades(usuario_id, desde, hasta);
