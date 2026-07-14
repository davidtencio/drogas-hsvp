# Fase 1 — Motor puro de lotes y FEFO

Fecha: 2026-07-13 (America/Costa_Rica)

## Alcance

Esta fase implementa únicamente lógica pura y pruebas. No modifica formularios, documentos de Firestore ni el comportamiento operativo de ingresos y egresos.

## Modelo establecido

Un ingreso trazable funciona como origen de lote mediante estos campos:

```js
{
  id,
  medId,
  type: 'IN',
  amount,
  lotNumber,
  expirationDate // YYYY-MM-DD
}
```

Un egreso conserva la asignación histórica:

```js
{
  type: 'OUT',
  amount,
  lotAllocations: [
    { sourceTransactionId, lotNumber, expirationDate, quantity }
  ]
}
```

El disponible se calcula como cantidad ingresada menos todas las asignaciones vinculadas. No se almacena un campo mutable `lotRemaining`.

## Funciones implementadas

Archivo: `src/utils/lots.js`

- `isValidExpirationDate`
- `isLotExpired`
- `getLotOrigins`
- `getLotUsage`
- `getAvailableLots`
- `compareLotsFEFO`
- `allocateLotsFEFO`
- `validateLotAllocations`
- `formatLotTooltip`

## Reglas comprobadas

- La expiración usa formato ISO `YYYY-MM-DD` y valida fechas reales.
- El lote permanece vigente durante todo su día de expiración.
- FEFO consume primero la expiración más próxima.
- En expiraciones iguales se consume primero el ingreso más antiguo.
- Un egreso puede dividirse entre varios lotes.
- Los lotes agotados y vencidos no se asignan automáticamente.
- Una insuficiencia devuelve un resultado estructurado y no una asignación parcial.
- Solo se aceptan cantidades enteras positivas.
- Los movimientos de inicialización con `affectsGlobalStock: false` sí funcionan como orígenes de lote.
- Los movimientos históricos sin lote no rompen los cálculos.
- La validación detecta orígenes inexistentes, instantáneas alteradas, totales incorrectos y sobreasignación.
- El tooltip se genera desde la instantánea guardada en el egreso.

## Verificaciones

- `npm test -- --run`: 53 de 53 pruebas aprobadas en 3 archivos.
- `npm run build`: aprobado.
- `npm run lint`: aprobado.
- `git diff --check`: aprobado.
- Advertencia previa no bloqueante: bundle principal superior a 500 kB.

## Criterio de salida

Cumplido. El motor está listo para ser consumido por las fases de registro de ingresos, inicialización y descargas FEFO, pero todavía no está conectado a la interfaz ni desplegado.
