# Continuacion del proyecto de lotes

Fecha de corte: 13 de julio de 2026, zona horaria America/Costa_Rica.

## Estado general

Las fases 0 a 5 estan implementadas, probadas y publicadas en `https://drogas-hsvp.web.app`.

El seguimiento FEFO esta habilitado gradualmente por medicamento:

- Medicamento no inicializado: conserva el flujo historico de egresos sin asignacion de lote.
- Medicamento inicializado: todas sus nuevas salidas normales, ediciones y rebajos de recetas abiertas deben tener asignacion FEFO.
- Activacion global: pendiente para la fase 5, despues de inicializar y verificar todos los medicamentos.

Al momento de la ultima verificacion en produccion figuraban `0 / 17` medicamentos inicializados. No se guardaron lotes ni movimientos durante las pruebas automatizadas o visuales.

## Trabajo completado

### Fase 0 — Respaldo y linea base

- El respaldo descarga las colecciones completas directamente desde Firestore y no solamente los 200 registros visibles.
- El JSON contiene resumen, cobertura y checksum verificable.
- Respaldo completo generado: `C:\Users\david\Downloads\backup_drogas_2026-07-14 (1).json`.
- Tamano: 13.317.819 bytes.
- Contenido verificado: 19.566 movimientos y 4.565 expedientes.
- SHA-256: `BEAF943BF591EF408D951F5AF13AF0F56663D1C586CC355FA2A88EA5536BA553`.
- Saldo total de la linea base: 1.234 unidades. El detalle por medicamento esta en `phase-0-baseline.md`.

### Fase 1 — Motor de lotes

- Validacion y normalizacion de lote, expiracion y cantidades enteras positivas.
- Calculo de existencias por lote.
- Orden FEFO por expiracion, antiguedad e id de origen.
- Division de una salida entre varios lotes.
- Exclusión de lotes vencidos.
- Validacion de asignaciones guardadas y deteccion de sobreasignacion.
- Formateo del tooltip de trazabilidad.

### Fase 2 — Ingresos con lote

- Todo nuevo ingreso ordinario exige cantidad, numero de lote y expiracion.
- Los lotes se normalizan en mayusculas.
- Un lote vencido requiere confirmacion explicita.
- Los ingresos muestran lote y expiracion en Kardex.
- Un ingreso ya consumido no permite modificar medicamento, cantidad, lote ni expiracion.

### Fase 3 — Inicializacion unica

- Asistente por medicamento dentro de Configuracion.
- Carga y verificacion del historial completo antes de calcular el saldo.
- Distribucion exacta del saldo entre uno o varios lotes.
- Prevencion de lotes duplicados con igual expiracion.
- Segunda comprobacion del saldo inmediatamente antes de guardar.
- Escritura atomica de movimientos iniciales y estado `completed`.
- Los movimientos iniciales usan `affectsGlobalStock: false`, por lo que crean existencia por lote sin duplicar el saldo global.
- El respaldo version 3 incluye `lotInitializationByMedId`.

### Fase 4 — Egresos FEFO

- FEFO se activa automaticamente para cada medicamento inicializado.
- Se consulta el historial completo antes de calcular la asignacion.
- Se bloquea una salida si los lotes vigentes no cubren la cantidad solicitada.
- Las asignaciones se guardan en `lotAllocations` con origen, lote, expiracion y cantidad.
- Las ediciones excluyen el consumo anterior y calculan una asignacion nueva.
- Los rebajos de recetas abiertas tambien asignan FEFO.
- La cantidad del egreso muestra el detalle mediante tooltip y un indicador de lotes.
- Los movimientos antiguos se identifican como registros sin trazabilidad de lote.

## Verificaciones realizadas

- Suite final: 63 pruebas aprobadas en 3 archivos.
- `npm run lint`: aprobado.
- `npm run build`: aprobado.
- `git diff --check`: aprobado.
- Despliegues de Firebase Hosting completados correctamente.
- Verificacion autenticada de la inicializacion de Morfina sin guardar: saldo completo de 189 unidades, conciliacion inicialmente bloqueada y mensajes correctos.
- La interfaz publicada cargo sin errores de consola en las verificaciones completadas.

## Actualizacion de fase 5 — 14 de julio de 2026

- Reintegros ahora exigen lote y expiracion.
- Ajustes absolutos quedan bloqueados despues de inicializar un medicamento.
- Cierres de medicamentos inicializados verifican integridad y usan el saldo recien calculado.
- Se agrego conciliacion entre saldo global, existencia fisica por lotes, existencia vigente y vencida.
- Cada movimiento nuevo invalida la verificacion anterior del medicamento.
- El gate exige 17/17 inicializados y todos conciliados, ademas de respaldo y sincronizacion limpia.
- Suite final de fase 5: 65 pruebas aprobadas.
- Detalle: `phase-5-integrity-release-gate.md`.

## Pendiente para la activacion operativa

1. Descargar un respaldo completo nuevo inmediatamente antes de la carga inicial y verificar su checksum en la sesion.
2. Realizar el conteo fisico e inicializar los 17 medicamentos, uno por uno.
3. Después de cada medicamento, comprobar:
   - saldo global sin cambios;
   - suma disponible por lotes igual al saldo;
   - lotes y expiraciones contra el conteo fisico;
   - estado de inicializacion persistido despues de recargar.
4. Ejecutar una prueba funcional controlada de extremo a extremo:
   - ingreso de lote;
   - egreso desde un lote;
   - egreso dividido entre lotes;
   - tooltip;
   - edicion/reasignacion;
   - receta abierta;
   - lote vencido e insuficiencia.
5. Confirmar que todas las condiciones del gate esten en `OK`.
6. Descargar y validar un respaldo posterior a la migracion.

## Precauciones para continuar

- La app esta en uso real y los saldos pueden cambiar durante el trabajo. Nunca reutilizar un saldo observado anteriormente para inicializar.
- Abrir siempre el asistente para que consulte el historial completo y calcule el saldo actual.
- No inicializar un medicamento sin confirmar fisicamente todos sus lotes y expiraciones.
- La inicializacion no se puede revertir desde la interfaz.
- No eliminar ni editar manualmente en Firestore movimientos de inicializacion o asignaciones FEFO.
- Mantener el modo gradual hasta cerrar los casos de reintegro, ajuste manual y anclas de inventario.

## Archivos principales

- `src/App.jsx`: interfaz, persistencia, respaldo, inicializacion y conexion FEFO.
- `src/utils/lots.js`: motor puro de lotes.
- `src/utils/lots.test.js`: pruebas del motor y trazabilidad.
- `src/utils/backup.js`: resumen y checksum del respaldo.
- `src/utils/backup.test.js`: pruebas del respaldo.
- `src/utils/inventory.js`: calculo de saldo con exclusion de movimientos que no afectan inventario global.
- `docs/phase-0-baseline.md` a `docs/phase-4-fefo-discharge.md`: detalle de cada fase.
