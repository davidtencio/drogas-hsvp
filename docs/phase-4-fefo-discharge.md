# Fase 4 — Descargas FEFO y trazabilidad

## Objetivo

Asignar automaticamente cada egreso a los lotes vigentes disponibles, consumiendo primero el que expire antes y conservando la trazabilidad en el movimiento.

## Implementacion

- FEFO se activa automaticamente por medicamento al completar su inicializacion unica de lotes.
- Los medicamentos pendientes de inicializacion conservan temporalmente el flujo historico sin asignacion, evitando interrumpir la operacion durante la migracion.
- Antes de asignar se carga el historial completo del medicamento desde Firestore.
- El motor FEFO consume primero la expiracion mas cercana; si hace falta, divide una salida entre varios lotes.
- Los lotes vencidos quedan visibles para trazabilidad, pero no se asignan automaticamente.
- Si la existencia vigente por lotes no alcanza, la salida se bloquea sin guardar una asignacion parcial.
- Cada egreso guarda una instantanea `lotAllocations` con id del ingreso origen, lote, expiracion y cantidad.
- La misma regla se aplica a egresos normales, ediciones de egresos y rebajos de recetas abiertas.
- Al editar un egreso se elimina temporalmente su consumo anterior y se calcula una asignacion FEFO nueva.
- La cantidad descargada en Kardex muestra un indicador de lotes y un tooltip con el detalle de cada asignacion.
- Los movimientos historicos anteriores a esta fase siguen mostrando que no poseen trazabilidad de lote.

## Seguridad operativa

- La app es de un solo usuario, por lo que la verificacion inmediatamente anterior al guardado es suficiente para el flujo operativo acordado.
- No se activa FEFO para un medicamento hasta completar su conciliacion inicial; el bloqueo global queda reservado para el gate de fase 5.
- Los ingresos consumidos mantienen protegidos medicamento, cantidad, lote y expiracion.

## Pruebas

- Asignacion desde un lote y division entre multiples lotes.
- Orden por expiracion y desempate por antiguedad del ingreso.
- Continuidad después de consumos parciales.
- Reasignacion al editar un egreso.
- Bloqueo cuando solo existen lotes vencidos.
- Rechazo de cantidades invalidas y faltantes de inventario vigente.
- Validacion de instantaneas y prevencion de sobreasignacion.
- Formato del tooltip para uno o varios lotes.
