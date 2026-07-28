# Fase 7 — Inmutabilidad del Cierre 24 Horas

## Objetivo

Convertir el `CIERRE 24 HORAS` en un corte contable real: los movimientos anteriores
a el dejan de poder editarse o eliminarse. Hasta ahora el cierre ya funcionaba como
ancla de saldo, pero nada impedia borrar un movimiento previo al ancla, lo que
descuadraba el saldo historico sin dejar rastro.

## Regla

Para cada medicamento, el `CIERRE 24 HORAS` mas reciente define un `cutoff` igual a
su propio timestamp. Todo movimiento de **ese** medicamento cuyo timestamp sea
`<= cutoff` queda congelado.

- La comparacion es `<=` y no `<` a proposito: asi el cierre mismo queda incluido y
  tampoco puede eliminarse, que es justo lo que protege el ancla de saldo.
- El alcance es **por medicamento**: cerrar FENTANYL no congela MORFINA.
- Los cierres de turno (`PRIMER`, `SEGUNDO`, `TERCER TURNO`) no congelan nada; solo
  el cierre de 24 horas cierra el periodo.
- Lo posterior al cierre sigue siendo editable hasta el proximo cierre de 24 horas.

## Que queda bloqueado

- Editar un movimiento congelado (boton oculto y validacion en el guardado).
- Eliminar un movimiento congelado, incluido el cierre.
- Eliminar un medicamento que tenga movimientos congelados: borraba sus movimientos
  en cascada, que era la misma destruccion por la puerta de atras.
- Corregir el lote de un ingreso congelado o de los egresos ya asignados a el.

## Que sigue permitido

Sobre un movimiento congelado se admiten unicamente anotaciones que no alteran
cantidades ni saldos:

| Campo | Origen |
|---|---|
| `crossCheckPharmacist`, `crossCheckedAt` | Control cruzado |
| `rxUsed`, `rxAdjusted`, `rxAdjustedAt`, `rxAdjustedBy`, `rxAdjustedFrom` | Seguimiento de recetas abiertas |

La lista vive en `CLOSURE_EDITABLE_FIELDS` (`src/App.jsx`) y debe mantenerse en
sincronia con la lista equivalente de `firestore.rules`.

## Cumplimiento en dos capas

**Interfaz.** `closureCutoffByMedId` fusiona los cortes calculados desde los
movimientos en memoria con los persistidos en Firestore. La validacion central esta
en `enqueueWrite`, paso obligatorio de toda escritura, y no solo en los botones: asi
ninguna ruta de la app puede tocar un movimiento congelado por error.

**Reglas de Firestore.** Las reglas no pueden hacer consultas, asi que el corte se
denormaliza en la coleccion `closureLocks` (un documento por medicamento, id = medId,
campo `cutoff`). La regla de `transactions` resuelve el corte con `get()` y deniega
`update`/`delete` sobre lo congelado.

Detalle importante: las reglas de Firestore se combinan de forma **permisiva**. El
`match /{subcollection=**}/{docId}` que existia concedia escritura a todo y habria
dejado decorativo cualquier bloqueo mas especifico, por lo que se sustituyo por un
`match` explicito por coleccion.

El corte solo puede **avanzar**. Retrocederlo se acepta unicamente como reinicio
explicito con `reset`, `resetReason` y `resetAt`.

## Excepciones auditadas

Dos operaciones reconstruyen la base completa y por tanto deben poder purgar tambien
historial cerrado. Ambas liberan los candados con `resetClosureLocks(motivo)`
**despues** de haber asegurado el respaldo:

- **Cierre de periodo automatico**: al alcanzar el limite de registros descarga el
  respaldo, libera los candados y purga el historial (`motivo: cierre_periodo`).
- **Restauracion de respaldo**: reemplaza la base entera (`motivo: restauracion:<archivo>`).
  Los cierres que traiga el respaldo vuelven a publicar su propio corte al cargarse.

## Retrocompatibilidad

Los cierres de 24 horas registrados antes de esta fase no dejaron candado en
Firestore. Un efecto publica el corte calculado cuando supera al persistido, de modo
que el bloqueo del servidor se activa solo para los cierres ya existentes. En
pantalla el bloqueo funciona desde el primer render, porque el corte tambien se
calcula desde los movimientos cargados.

Los registros antiguos sin `createdAt` cuentan como timestamp `0` en las reglas: si
su medicamento tiene un corte, quedan protegidos. Ante la duda se protege el dato.

## Verificacion

- `src/utils/inventory.test.js`: 11 casos sobre el corte y el bloqueo (alcance por
  medicamento, inclusion del cierre, fallback a la fecha visible, fusion de cortes).
- Reglas verificadas contra el emulador de Firestore con
  `@firebase/rules-unit-testing`: 18 casos que cubren denegar edicion y borrado de lo
  congelado, permitir lo posterior al cierre, permitir las anotaciones de la lista
  blanca, rechazar que se cuele un campo prohibido junto a una anotacion, y la
  monotonia del corte.

## Limitacion conocida

Estas reglas impiden el error humano y cierran las rutas de la propia app, pero no
convierten el reinicio de candados en un privilegio de administrador: cualquier
usuario autenticado puede emitir un reinicio marcado. Restringirlo de verdad exige
custom claims de Firebase Auth o una Cloud Function, ninguna de las dos presentes hoy
en el proyecto.
