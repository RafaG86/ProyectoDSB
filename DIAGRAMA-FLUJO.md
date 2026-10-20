# DSB Transportes — Diagrama de flujo del proceso

Estado del sistema a la fecha. Los diagramas usan [Mermaid](https://mermaid.js.org/): se ven directamente en GitHub y en VS Code (con la extensión *Markdown Preview Mermaid Support* o similar).

Lo que aún **no** está construido aparece en gris y con borde punteado (sección 6).

---

## 1. Flujo general

```mermaid
flowchart TD
    V([Visitante]) --> L[Landing page<br/>tours, contacto]
    L --> BU[Buscador: tour, traslado o empresa<br/>lleva a reservar con lo elegido]
    BU --> REG
    L --> CF[Formulario corto de cotización<br/>sin necesidad de cuenta]
    CF --> CW[(Contacto web)]
    CW --> CA[Aviso al equipo y lista de Contactos web<br/>se contacta por WhatsApp o teléfono]
    L --> REG[Registro público<br/>nombre, apellidos, correo y teléfono internacional]
    L --> LOGIN[Ingresar<br/>correo y contraseña]
    REG -->|siempre crea un cliente<br/>el indicativo del teléfono da país e idioma| LOGIN

    LOGIN -->|credenciales incorrectas<br/>o usuario desactivado| LOGIN
    LOGIN --> NIVEL{Nivel de acceso<br/>del usuario}

    NIVEL -->|Cliente| PC[Panel de cliente]
    NIVEL -->|Empleado| PE[Panel de empleado]
    NIVEL -->|Administrador| PA[Panel de administración]

    PC --> C1[Pedir un servicio]
    C1 --> RES[(Reserva<br/>estado: pendiente)]

    RES --> NOT[[Aviso inmediato<br/>campana + notificación en el celular]]
    NOT --> A1[Admin ve la solicitud<br/>y empieza a revisarla]
    PA --> A1
    A1 --> A1b{Lleva mascotas<br/>o niños?}
    A1b -->|Sí| A1c[Autoriza o rechaza el transporte<br/>según las notas del cliente]
    A1b -->|No| A2
    A1c --> A2[Cotiza con el tarifario<br/>+ peajes + viáticos]
    A2 --> A3[Asigna conductor y vehículo<br/>solo conductores libres a esa hora]
    A3 --> D1[El conductor recibe el aviso<br/>y revisa el servicio]
    D1 --> D2{El conductor responde}
    D2 -->|No puedo, con motivo| D3[Vuelve al admin<br/>para asignar a otro]
    D3 --> A3
    D2 -->|Acepta| P1[Cliente paga por Nequi<br/>PAGO SIMULADO: envía el valor y el código,<br/>y sube el comprobante]
    P1 --> P2[Admin verifica el comprobante:<br/>valor, número de la empresa y código]
    P2 -->|Rechaza con motivo| P1
    P2 -->|Confirma el pago| A4b{Quedan 24 h o más<br/>hasta la recogida?}
    A4b -->|No| A4c[No se puede confirmar:<br/>acordar otra fecha o cancelar]
    A4b -->|Sí| RES2[(Reserva confirmada)]

    RES2 -->|aviso| C2
    RES2 --> E1[Conductor ve el servicio<br/>confirmado]
    PE --> E1
    RES2 --> C2[Cliente ve estado,<br/>desglose y total]
    PC --> C2

    E1 --> FIN[Servicio realizado]
    FIN --> A5[Admin marca como completada]

```

---

## 2. Estados de una reserva

```mermaid
stateDiagram-v2
    [*] --> pendiente: el cliente envía la solicitud

    pendiente --> confirmada: al confirmar el admin el pago; exige cotización, autorización resuelta, conductor aceptó y 24 h de anticipación
    pendiente --> cancelada: admin cancela, o el cliente si aún no envió comprobante de pago

    confirmada --> completada: admin marca el servicio como realizado
    confirmada --> cancelada: solo el admin (el cliente debe contactar a la empresa)
    confirmada --> pendiente: admin la devuelve a pendiente

    cancelada --> pendiente: admin la reabre

    completada --> [*]: estado definitivo
```

Reglas que aplica el sistema:

- Solo se puede **cotizar** y **asignar** mientras la reserva está *pendiente* o *confirmada*.
- No se puede **confirmar** una reserva sin cotización.
- **Pago (simulado):** la reserva solo queda confirmada cuando el administrador verifica el comprobante de pago. El cliente puede pagar cuando hay cotización, conductor aceptado y autorización (si aplica). Paga en pesos colombianos (la cotización se convierte con la tasa del día), indica su número Nequi y la referencia, escribe en el mensaje de la transferencia el código único de la reserva y sube el comprobante; el admin comprueba valor, número de la empresa y código. Si lo rechaza, el cliente puede corregirlo y reenviarlo. Con el comprobante enviado la cotización queda bloqueada.
- **Eliminar una reserva:** por ahora solo el administrador, con una justificación obligatoria (por ejemplo, "es una prueba"). Se borra la reserva con su comprobante de pago y sus avisos; queda un registro (quién, cuándo, por qué y los datos principales) en *Reservas eliminadas*. Opcionalmente se avisa al cliente y al conductor. En producción, quien deberá autorizar la eliminación es el cliente que hizo la reserva.
- **Cancelación por el cliente:** solo mientras la reserva está pendiente y sin comprobante enviado. Después, cualquier cambio lo hace la empresa.
- Debe haber un **conductor asignado que haya aceptado** el servicio. Si lo rechaza (con motivo), la reserva vuelve al administrador para asignar a otro. Con la reserva confirmada solo se puede cambiar el vehículo; para cambiar de conductor hay que devolverla antes a *pendiente*.
- Si lleva **mascotas o niños**, el admin debe **autorizar** el transporte antes de confirmar; si lo rechaza (con una nota para el cliente) no se puede confirmar. La decisión solo se toma mientras está *pendiente*.
- La recogida debe ser como mínimo **24 horas después de formalizar (confirmar)** la reserva. Se exige al reservar y de nuevo al confirmar; el valor (24 h) se cambia en *Ajustes de atención*. Todo en hora de Bogotá, y el origen siempre es Bogotá.
- *Completada* es definitiva: no se puede cambiar, cotizar ni asignar.

---

## 3. Panel de cliente

```mermaid
flowchart TD
    A([Cliente inicia sesión]) --> B[Resumen<br/>próximos, pendientes, completados<br/>+ lista de reservas]

    B --> C[Nueva reserva]
    C --> C0{Perfil completo?<br/>nombre, apellidos, teléfono internacional}
    C0 -->|No| CP[Completa su perfil]
    CP --> C
    C0 -->|Sí| C00[Origen fijo: Bogotá]
    C00 --> D{Tipo de servicio}
    D -->|Tour| D1[Elige un tour de la lista]
    D -->|Servicio especial| D2[Escribe el destino]
    D1 --> E[Fecha y hora de recogida hora de Bogotá,<br/>dirección de recogida, pasajeros, moneda y notas]
    D2 --> E
    E --> E2[Mascotas o niños: debe describirlos<br/>para que se pueda autorizar]
    E2 --> F{Datos válidos?}
    F -->|No: fecha pasada, hora mala,<br/>pasajeros fuera de 1-60, etc.| E
    F -->|Sí| G[(Reserva creada<br/>pendiente)]
    G --> H

    B --> H[Detalle de la reserva]
    H --> I{Tiene cotización?}
    I -->|No, servicio especial| I1[Muestra: A cotizar]
    I -->|No, tour| I2[Muestra precio de lista<br/>+ cotización pendiente]
    I -->|Sí| I3[Muestra desglose:<br/>transporte, peajes, viáticos, total]
    H --> J[Conductor y vehículo asignados]

    H --> K{Pendiente y sin comprobante<br/>de pago enviado?}
    K -->|Sí| L[Cancelar reserva]
    K -->|No| K2[No puede cancelar:<br/>contacta a la empresa]
    H --> PG[Pagar por Nequi cuando haya cotización,<br/>conductor aceptado y autorización]
    L --> M[(Reserva cancelada)]

    A --> P[Mi perfil<br/>datos y contraseña]
```

---

## 4. Panel de administración

```mermaid
flowchart TD
    A([Admin inicia sesión]) --> B[Panel<br/>estadísticas y solicitudes por atender]

    B --> R[Reservas<br/>filtro por estado]
    R --> D[Detalle de la reserva]

    D --> Q[Cotización]
    Q --> Q0[Elige la moneda de la cotización<br/>USD, EUR o COP; propone la que pidió el cliente]
    Q0 --> Q1[Elige tarifa del tarifario<br/>si está en otra moneda se convierte con la tasa del día]
    Q1 --> Q2[Escribe km totales]
    Q2 --> Q3[Agrega a mano:<br/>peajes y viáticos del conductor, en esa moneda]
    Q3 --> Q4["Total = max(km × precio/km, mínima)<br/>+ peajes + viáticos<br/>redondeado a los decimales de la moneda"]
    Q4 --> Q5[(Se guarda con la tarifa convertida,<br/>su moneda original y la tasa usada)]

    D --> S[Asignación]
    S --> S1[Elige conductor<br/>libre / ocupado con otra reserva /<br/>fechas no disponibles]
    S --> S2[Elige vehículo<br/>no en mantenimiento]
    S2 --> S3{Capacidad del vehículo<br/>suficiente para los pasajeros?}
    S3 -->|No| S2
    S3 -->|Sí| S4[(Asignación guardada<br/>conductor: pendiente de aceptar)]

    D --> E[Cambio de estado<br/>según el diagrama 2]
    D --> X[Eliminar la reserva<br/>justificación obligatoria, p. ej. es una prueba]
    X --> X2[(Se borra con su comprobante y avisos,<br/>y queda el registro de quién y por qué)]
    B --> X3[Historial de reservas eliminadas]

    B --> T[Tarifario<br/>nombre, precio por km, tarifa mínima, activa]
    B --> DV[Divisas<br/>tasas de cambio por 1 USD, a mano]
    B --> U[Usuarios<br/>crear, activar y desactivar]
    B --> N[Niveles de acceso<br/>crear niveles y marcar permisos]

    T -.->|alimenta| Q1
    DV -.->|alimenta| Q0
    N -.->|define qué ve cada usuario| B
```

**Divisas.** USD es la moneda base. Cada tarifa y cada tour tienen su moneda; la cotización se emite en una moneda elegida, y se guarda con la tasa del momento, así que cambiar las tasas no altera cotizaciones ya hechas. Los precios de lista y las equivalencias (≈) se muestran en la moneda que cada visitante elige en la barra superior.

---

## 4b. Avisos, tiempos de respuesta y celular

```mermaid
flowchart TD
    N1[Llega una solicitud de reserva] --> N2[Se guarda el aviso en la campana<br/>de cada persona que gestiona reservas]
    N2 --> N3{Activó las notificaciones<br/>en su celular?}
    N3 -->|Sí| N4[Notificación push urgente<br/>con enlace a la reserva]
    N3 -->|No| N5[Solo ve el número rojo<br/>en la campana al abrir la app]
    N4 --> N6[Toca la notificación<br/>y se abre la reserva]
    N5 --> N6
    N6 --> N7[Primera respuesta<br/>cotizar, autorizar o cancelar]
    N7 --> N8[(Se registra el tiempo de respuesta)]

    J[Revisión automática cada minuto] --> J1{Sin respuesta pasado<br/>el tiempo objetivo?}
    J1 -->|Sí, una sola vez| J2[Alerta: solicitud sin responder]
    J --> J3{Faltan pocas horas para el último<br/>momento de confirmar?}
    J3 -->|Sí, una sola vez| J4[Alerta: se acaba el plazo]
    J2 --> N4
    J4 --> N4

    N7 -.->|cotiza, confirma, autoriza, cancela| C[Aviso al cliente<br/>en su idioma]
```

- **Tiempo de respuesta** = desde que llega la solicitud hasta la primera acción del equipo. El objetivo es configurable (60 min por defecto) y el panel muestra el tiempo medio de los últimos 30 días y qué porcentaje cumplió el objetivo.
- **Plazo para confirmar** = hora de recogida − 24 h. El detalle de cada reserva muestra cuánto queda y, si ya pasó, no deja confirmar.
- **Quién recibe los avisos del equipo:** el administrador y cualquier nivel con el permiso *Cotizar, asignar y cambiar el estado de reservas*.
- **Celular:** la app se puede instalar (PWA) y las notificaciones push solo funcionan con HTTPS; en iPhone, además, hay que instalarla en la pantalla de inicio.

**Disponibilidad del conductor.** Un conductor no está disponible si (1) marcó esas fechas como no disponibles en *Mi disponibilidad*, o (2) ya tiene otro servicio activo que se cruza en horario. Un servicio ocupa desde la recogida hasta su duración (la del tour, o la duración por defecto de *Ajustes de atención* en los servicios especiales; 8 h de fábrica). El admin no puede asignar a un conductor no disponible, y si el conductor rechaza un servicio o se cancela, queda libre de nuevo. Si el conductor no responde en el tiempo acordado (60 min de fábrica) se avisa al administrador.

---

## 5. Niveles de acceso y permisos

El acceso se decide por **permisos**, no por nombre de rol. Cada nivel es un conjunto de permisos que el administrador marca en *Niveles de acceso*. Los cambios se aplican de inmediato; si se desactiva a un usuario, pierde la sesión en su siguiente clic.

| Permiso | Administrador | Empleado | Cliente |
|---|:---:|:---:|:---:|
| Ver el panel de administración | ✅ | | |
| Crear y activar/desactivar usuarios | ✅ | | |
| Ver todas las reservas | ✅ | | |
| Cotizar, asignar y cambiar estado de reservas | ✅ | | |
| Gestionar el tarifario por kilómetro | ✅ | | |
| Gestionar divisas y tasas de cambio | ✅ | | |
| Verificar y confirmar pagos | ✅ | | |
| Eliminar reservas (con justificación) | ✅ | | |
| Gestionar tiempos de respuesta y anticipación | ✅ | | |
| Gestionar niveles de acceso | ✅ | | |
| Ver sus servicios asignados | ✅ | ✅ | |
| Aceptar o rechazar los servicios que le asignan | ✅ | ✅ | |
| Indicar sus fechas no disponibles | ✅ | ✅ | |
| Crear sus propias reservas | ✅ | | ✅ |
| Ver sus propias reservas | ✅ | | ✅ |
| Cancelar sus propias reservas (solo antes de pagar) | ✅ | | ✅ |
| Pagar sus reservas | ✅ | | ✅ |

- El **Administrador** siempre tiene todos los permisos y no se puede editar.
- Los niveles de **Empleado** y **Cliente** vienen con esos permisos por defecto, pero se pueden cambiar.
- El admin puede crear niveles nuevos (por ejemplo, *Supervisor* o *Despachador*) y nadie puede conceder permisos que no tiene.
- Todos los usuarios tienen **Mi perfil** (cambiar nombre, teléfono y contraseña).

---

## 6. Pendiente de construir

```mermaid
flowchart LR
    subgraph Hecho
        H1[Landing, registro e ingreso]
        H2[Niveles de acceso y permisos]
        H3[Panel de cliente]
        H4[Tarifario por km y cotización]
        H5[Asignación y estados]
        H7[Divisas USD, EUR y COP<br/>tasas manuales y selector de moneda]
        H10[Pago simulado por Nequi<br/>con comprobante y verificación del admin]
        H9[Confirmación del conductor<br/>y disponibilidad de conductores]
        H8[Avisos, tiempos de respuesta<br/>y app instalable en el celular]
        H6[Idiomas ES / EN / PT y tema claro-oscuro]
    end

    subgraph Pendiente
        P1[Gestión de vehículos<br/>agregar, editar, mantenimiento]:::pend
        P2[Aceptación de la cotización<br/>por el cliente]:::pend
        P9[Pasarela de pago real<br/>y reembolsos]:::pend
        P10[En producción: el cliente autoriza<br/>la eliminación de su reserva]:::pend
        P3[Agenda de vehículos<br/>avisar si un vehículo ya está ocupado]:::pend
        P4[Gestión de tours<br/>crear, editar, precios]:::pend
        P5[Protección CSRF<br/>en los formularios]:::pend
        P6[Panel de empleado completo<br/>iniciar y cerrar servicio]:::pend
        P7[Avisos por correo, SMS o WhatsApp<br/>además del celular]:::pend
        P8[Turnos de guardia<br/>quién recibe los avisos según la hora]:::pend
    end

    classDef pend fill:#eee,stroke:#999,stroke-dasharray: 4 3,color:#555;
```
