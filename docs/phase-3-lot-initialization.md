# Fase 3 — Inicializacion unica de lotes

## Objetivo

Conciliar una sola vez el saldo historico de cada medicamento con sus lotes y fechas de expiracion, sin modificar el saldo global existente.

## Implementacion

- La configuracion muestra el progreso por medicamento y bloquea una segunda inicializacion.
- Al abrir el asistente se carga el historial completo del medicamento y se calcula nuevamente su saldo.
- Cada fila exige numero de lote, fecha de expiracion valida y cantidad entera positiva.
- No se permiten lotes duplicados con la misma fecha dentro de una conciliacion.
- La suma distribuida debe ser exactamente igual al saldo verificado.
- Antes de guardar se vuelve a consultar el historial; si el saldo cambio, la operacion se cancela.
- Los movimientos y el estado `completed` se escriben en un unico batch de Firestore.
- Los movimientos llevan `isLotInitialization: true` y `affectsGlobalStock: false`: crean existencias por lote para FEFO, pero no duplican el inventario global.
- Los medicamentos con saldo cero se pueden marcar como inicializados sin crear movimientos.
- Los lotes vencidos requieren confirmacion y quedan trazados, pero el motor FEFO no los asigna automaticamente.
- El respaldo version 3 incluye el estado de inicializacion por medicamento.

## Verificaciones

- `npm test -- --run`: 61 pruebas aprobadas.
- `npm run build`: compilacion aprobada.
- `npm run lint`: sin errores.
- `git diff --check`: sin errores de espacios.

## Restriccion operativa

La inicializacion es irreversible desde la interfaz. Debe ejecutarse con el JSON completo de respaldo disponible y despues de confirmar fisicamente las cantidades, lotes y expiraciones.
