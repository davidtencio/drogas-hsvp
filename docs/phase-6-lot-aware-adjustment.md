# Fase 6 — Ajuste manual compatible con lotes

Cierra el caso que la fase 5 dejo pendiente: el ajuste absoluto estaba bloqueado
para los medicamentos ya inicializados porque movia el saldo global sin tocar la
existencia por lote.

## Por que estaba bloqueado

El ancla de saldo (`isCierre: true`, `totalMedicamento`) es un corte por tiempo:
`computeMedStock` ignora todo lo anterior a ella. La existencia por lote no tiene
ese corte — `getLotOrigins` acumula todos los ingresos con lote de la historia y
les resta todas las asignaciones. Un ancla nueva por si sola dejaba vivos los
lotes viejos y garantizaba el descuadre.

## Modos disponibles

Ambos viven en la misma tarjeta **Ajuste Manual de Saldo** de Configuracion y
piden la misma clave de seguridad y farmaceutico responsable. Solo aparecen para
medicamentos inicializados; los demas conservan el ajuste absoluto historico.

### Recuento de existencias

Se declaran los lotes que existen fisicamente. La suma **es** el saldo nuevo: no
se digita aparte. En un solo batch se escriben:

1. un egreso de liberacion con `affectsGlobalStock: false` cuyas asignaciones
   consumen todos los lotes remanentes, incluidos los vencidos;
2. un ingreso por lote declarado, tambien `affectsGlobalStock: false`;
3. el ancla de saldo con el total declarado.

Saldo global y existencia por lote quedan iguales por construccion. Nada se
borra: todo queda como movimientos compensatorios auditables, con
`adjustmentGroupId` comun.

Un recuento sin filas es el **ajuste a cero**: libera lo remanente, deja el saldo
en 0 y no pide lote ni fecha.

### Correccion de lote o expiracion

Cambia el numero de lote o la fecha sin tocar cantidades, por lo que no lleva
ancla. Reescribe el ingreso de origen y tambien el snapshot que quedo guardado en
`lotAllocations` de cada egreso ya asignado a ese lote; de lo contrario el Kardex
historico conservaria el dato erroneo y `validateLotAllocations` lo marcaria como
`LOT_SNAPSHOT_MISMATCH`.

## Salvaguardas

- Exige cola de escritura vacia (`pendingCount === 0`), porque escribe en batch
  directo y no por la cola.
- Reverifica contra Firestore inmediatamente antes de grabar: si el saldo global
  o la existencia por lote cambiaron mientras se contaba, aborta, recarga y pide
  revisar. La app esta en uso real.
- Los lotes vencidos declarados en un recuento exigen confirmacion explicita.
- Cada ajuste invalida la verificacion de integridad previa del medicamento, que
  debe volver a correrse para el gate de release.

## Motor puro

- `planLotRecount(transactions, medId, rows)`: valida filas, detecta lotes
  duplicados y devuelve el total nuevo, la existencia actual y las asignaciones
  de liberacion.
- `planLotCorrection(transactions, medId, sourceTransactionId, cambios)`:
  devuelve el origen a corregir y los egresos con su `lotAllocations` ya
  reescrito.

Ambas con pruebas en `src/utils/lots.test.js`.
