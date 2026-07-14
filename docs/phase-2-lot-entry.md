# Fase 2 — Registro de lote y expiración en ingresos

Fecha: 2026-07-13 (America/Costa_Rica)

## Alcance implementado

- Los ingresos nuevos requieren cantidad, número de lote y fecha de expiración.
- El lote se normaliza a mayúsculas y sin espacios extremos.
- La expiración se guarda como `YYYY-MM-DD`.
- Las cantidades deben ser enteros mayores que cero.
- Una fecha vencida requiere confirmación explícita.
- Lote y expiración se muestran debajo de la cantidad en Kardex reciente e histórico.
- Los ingresos históricos sin lote continúan cargando sin errores.
- La edición reconoce correctamente movimientos `IN` y muestra su formulario de ingreso.
- Si un ingreso ya tiene unidades asignadas, medicamento, cantidad, lote y expiración quedan protegidos; el farmacéutico todavía puede corregirse.

## Compatibilidad

Los egresos todavía no consumen lotes. Esa conexión pertenece a la fase FEFO posterior. Por ello, esta fase solo añade trazabilidad a ingresos nuevos y prepara la protección para cuando existan `lotAllocations`.

El formato de respaldo ya incluye automáticamente los campos nuevos porque los movimientos se serializan completos.

## Pruebas

Se añadieron casos para:

- Normalización de lote.
- Validación conjunta de cantidad, lote y expiración.
- Edición permitida antes del primer consumo.
- Bloqueo de cambios de trazabilidad después del consumo.
- Permiso para corregir campos no relacionados con trazabilidad.

## Verificaciones

- `npm test -- --run`: 57 de 57 pruebas aprobadas.
- `npm run build`: aprobado.
- `npm run lint`: aprobado.
- Advertencia previa no bloqueante: bundle principal superior a 500 kB.

## Criterio de salida

Cumplido. Firebase Hosting fue actualizado y se verificó en una sesión autenticada que:

- El saldo de referencia de Morfina continúa en 189.
- El ingreso presenta cantidad, número de lote, fecha de expiración y farmacéutico.
- Los tres campos de trazabilidad son obligatorios.
- Cantidad utiliza mínimo 1 y paso entero 1.
- Expiración utiliza un control de fecha.
- No se generó ni modificó ningún movimiento durante la verificación.
- No hubo errores de consola.
