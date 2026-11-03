# Descarte de medicamento vencido

Los lotes vencidos se quedaban en el inventario: FEFO los salta en los egresos,
pero siguen contando en el saldo global y en la existencia por lote. La única
forma de sacarlos era un recuento, que reescribe todos los lotes.

## Dónde está

Configuración → **Lotes y Expiraciones Disponibles**. Al consultar un medicamento
con existencia vencida aparece el panel **Descartar medicamento vencido**:

1. Marcar los lotes vencidos a descartar. Por defecto vienen todos marcados.
2. Elegir el farmacéutico responsable y, si se quiere, una observación (acta, destino).
3. Confirmar e ingresar la clave de seguridad.

Solo se pueden descartar medicamentos con lotes inicializados. Para los demás se
sigue usando el ajuste manual de saldo.

## Qué se graba

Un único egreso (`type: 'OUT'`) con:

- `service: 'DESCARTE POR VENCIMIENTO'` y `isExpiredDisposal: true`;
- `lotAllocations` que consumen solo los lotes vencidos elegidos, con toda su existencia;
- la observación con los lotes, las fechas y las cantidades.

A diferencia de la liberación del recuento, este egreso **sí afecta el saldo
global**: el saldo y la existencia por lote bajan la misma cantidad, así que la
integridad se conserva. Se ve en el Kardex como cualquier salida.

`isExpiredDisposal` lo excluye del consumo por servicio, de la tendencia diaria,
de la salida semanal y de los despachos entre cierres de tercer turno.

## Salvaguardas

- Pide conexión y la cola de escritura vacía.
- Antes de grabar, vuelve a cargar el historial desde Firestore. Si el saldo o los
  lotes vencidos cambiaron, cancela y recarga.
- El egreso pasa `validateLotAllocations` antes de escribirse.
- Un lote que vence hoy todavía está vigente y no aparece para descarte.
- Invalida la verificación de integridad previa del medicamento.

## Motor puro

`planExpiredDisposal(transactions, medId, { asOf, lotKeys })` en `src/utils/lots.js`,
con pruebas en `src/utils/lots.test.js`.
