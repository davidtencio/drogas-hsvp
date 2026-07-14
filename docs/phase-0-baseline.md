# Fase 0 — Línea base previa a lotes

Fecha de ejecución: 2026-07-13 (America/Costa_Rica)

## Estado del repositorio

- Rama: `master`
- Seguimiento: `origin/master`
- Commit base: `0db73f2f1c2b765472002a9dd7c6c3c5a326ad72`
- Último commit: `0db73f2 2026-07-12T19:51:07-06:00 Agrega informe de fentanilo para NotebookLM`
- Estado inicial: limpio, sin archivos modificados ni archivos nuevos.

## Verificaciones automáticas

| Verificación | Resultado | Detalle |
|---|---|---|
| `npm test -- --run` | Aprobada | 1 archivo, 31 pruebas aprobadas |
| `npm run build` | Aprobada | 1970 módulos transformados |
| `npm run lint` | Aprobada | Sin errores ni advertencias de ESLint |

### Observación no bloqueante

Vite reportó que el bundle principal minificado mide 701.42 kB, por encima del umbral recomendado de 500 kB. Esta advertencia ya forma parte de la línea base y no fue introducida por la funcionalidad de lotes.

## Verificación operativa

- La aplicación de producción responde en `https://drogas-hsvp.web.app/`.
- La navegación llegó correctamente a la pantalla de autenticación.
- No se utilizaron credenciales ni se modificaron datos.
- El navegador de verificación no tiene una sesión autenticada.

## Respaldo descargado

- Archivo: `backup_drogas_2026-07-14.json`
- Fecha local del archivo: `2026-07-13T19:52:07-06:00`
- Tamaño: 192018 bytes
- Versión del esquema: 2
- Organización: `hsvp`
- Medicamentos: 17
- Movimientos incluidos: 200
- Expedientes incluidos: 200
- Entradas de bitácora: 1
- Servicios: 17
- Farmacéuticos: 22
- Condiciones: 10
- Checksum interno: válido
- SHA-256: `42182FC74E35D6EB46652E18DE4DD0C6179E5B2EB1C8A29BE73C8BE6AF4682FC`

### Hallazgo crítico sobre la cobertura

El archivo es estructuralmente válido, pero no puede certificarse como respaldo completo. La app carga inicialmente un máximo de 200 documentos por colección y la descarga actual serializa los arreglos cargados en memoria. Que el archivo contenga exactamente 200 movimientos y 200 expedientes indica que probablemente representa solo la primera página de ambas colecciones.

No se utilizarán los saldos calculados desde este archivo como línea base hasta confirmar y corregir la cobertura del respaldo.

### Corrección preparada

Se modificó localmente el generador de respaldos para:

- Consultar directamente al servidor de Firestore las colecciones completas `transactions`, `expedientes` y `bitacora`.
- No depender de los 200 registros cargados en la interfaz.
- Bloquear la descarga mientras existan escrituras pendientes de sincronización.
- Marcar el JSON con `backupCoverage.complete: true` y `source: firestore-server`.
- Mantener compatible el checksum y el esquema de restauración versión 2.

Verificaciones posteriores a la corrección:

- `npm test -- --run`: 34 de 34 pruebas aprobadas.
- `npm run build`: aprobado.
- `npm run lint`: aprobado.
- `git diff --check`: aprobado.

La comprobación local autenticada no es posible sin la configuración Firebase de producción. Falta publicar la corrección, generar un nuevo JSON y validar que sus conteos superen o coincidan con los totales reales de Firestore.

### Publicación de la corrección

- Firebase Hosting actualizado el 2026-07-13.
- Solo se desplegó Hosting; Firestore y sus datos no fueron modificados.
- La compilación definitiva utilizó la configuración oficial de la aplicación web obtenida desde Firebase.
- Bundle verificado en producción: `assets/index-Cd4vtaOw.js`.
- La pantalla de autenticación carga correctamente y sin errores de consola.
- Pendiente: descargar y validar el nuevo respaldo marcado con `backupCoverage.complete: true`.

## Respaldo completo validado

- Archivo: `backup_drogas_2026-07-14 (1).json`
- Fecha local: `2026-07-13T20:07:34-06:00`
- Tamaño: 13317819 bytes
- Versión del esquema: 2
- Cobertura declarada: completa
- Fuente: `firestore-server`
- Medicamentos: 17
- Movimientos: 19566
- Expedientes: 4565
- Bitácora: 1
- Servicios: 17
- Farmacéuticos: 22
- Condiciones: 10
- Checksum interno: válido
- SHA-256: `BEAF943BF591EF408D951F5AF13AF0F56663D1C586CC355FA2A88EA5536BA553`

### Saldos de referencia

| Medicamento | Saldo |
|---|---:|
| MORFINA 15 MG | 189 |
| FENTANYL 50 MCG | 248 |
| DIAZEPAM 10 MG | 97 |
| MIDAZOLAM 15 MG | 288 |
| CLONAZEPAM 2 MG | 54 |
| FENOBARBITAL 50 MG | 20 |
| PROPOFOL | 57 |
| LEVONORGESTREL | 6 |
| KETAMINA | 16 |
| DOLUTEGRAVIR | 90 |
| DEXMETOMEDINA | 35 |
| AZITROMICINA | 10 |
| TENECTEPLASA | 2 |
| ALTEPLASA | 6 |
| LORAZEPAM 2 MG | 60 |
| DIAZEPAM 5 MG | 56 |
| CLONAZEPAM GOTAS | 0 |
| **Total** | **1234** |

Los saldos calculados desde los 19566 movimientos coinciden con los valores mostrados en el dashboard de producción, incluido el total de 1234 unidades.

## Pendientes para cerrar la fase 0

- [x] Descargar desde la app un respaldo JSON de producción antes de modificar el modelo de datos.
- [x] Guardar el nombre, fecha, versión, hash y resumen del respaldo.
- [x] Obtener o generar un respaldo que incluya todas las páginas de las colecciones.
- [x] Registrar el saldo mostrado de cada medicamento.
- [ ] Seleccionar casos reales de referencia: saldo cero, un ingreso, varios ingresos, receta abierta y cierre.
- [ ] Verificar manualmente ingreso, egreso, edición, eliminación y restauración en un entorno de prueba o con registros de prueba autorizados.
- [x] Confirmar que los saldos registrados coinciden con el dashboard antes de comenzar la fase 1.

## Regla de avance

No iniciar la migración ni la inicialización de lotes hasta contar con el respaldo operativo y la tabla de saldos de referencia.
