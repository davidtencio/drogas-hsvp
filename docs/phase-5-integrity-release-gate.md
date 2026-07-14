# Fase 5 — Integridad y gate de activacion global

## Objetivo

Cerrar los movimientos especiales que podian separar el saldo global de las existencias por lote y preparar una activacion global verificable de FEFO.

## Reglas implementadas

### Reintegros

- Todo reintegro exige cantidad entera positiva, numero de lote y fecha de expiracion.
- El reintegro se registra como un origen de existencias por lote.
- Si el lote esta vencido, requiere confirmacion y permanece fuera de la asignacion FEFO automatica.

### Ajuste manual de saldo

- El ajuste absoluto se mantiene disponible solamente antes de inicializar un medicamento.
- Despues de inicializar lotes se bloquea, porque reemplazar el saldo sin indicar lotes destruiria la conciliacion.
- Las correcciones posteriores deben registrarse como entradas o salidas trazables.

### Cierres e inventarios

- Un cierre de un medicamento inicializado carga el historial completo y verifica integridad.
- Se bloquea si el saldo global no coincide con las existencias fisicas por lote.
- El ancla del cierre usa el saldo recien calculado durante la verificacion, no un valor anterior de pantalla.
- Los cierres no consumen ni crean lotes, porque no representan movimiento fisico.

## Conciliacion

La nueva verificacion calcula por medicamento:

- saldo global;
- existencia fisica total por lotes;
- existencia vigente utilizable por FEFO;
- existencia vencida;
- cantidad de lotes con saldo.

La integridad es correcta cuando el saldo global coincide exactamente con la existencia fisica por lotes. Los vencidos forman parte del inventario fisico, aunque no del saldo utilizable automaticamente.

Cada escritura de transaccion invalida la verificacion de ese medicamento. Esto evita aprobar el gate con una comprobacion anterior a un movimiento nuevo.

## Gate de release

El gate exige simultaneamente:

1. cero escrituras pendientes;
2. cero errores activos de sincronizacion;
3. almacenamiento local sin riesgo;
4. respaldo completo verificado en la sesion;
5. todos los medicamentos inicializados;
6. integridad correcta y vigente en todos los medicamentos.

La interfaz permite verificar un medicamento o todos los ya inicializados. El gate debe permanecer bloqueado mientras falte cualquier medicamento; no se fuerza una activacion prematura en la app que esta en uso real.

## Pruebas y verificaciones

- Resumen de inventario separando existencia fisica, vigente y vencida.
- Reconocimiento de movimientos de inicializacion como origen de lote sin alterar saldo global.
- Suite completa: 65 pruebas aprobadas.
- Lint y compilacion aprobados.

## Procedimiento operativo pendiente

1. Descargar un respaldo completo nuevo.
2. Conciliar fisicamente e inicializar los 17 medicamentos.
3. Verificar integridad despues de cada inicializacion.
4. Resolver cualquier descuadre antes de continuar.
5. Ejecutar “Verificar integridad de todos los inicializados”.
6. Confirmar que el gate muestre todas las condiciones en `OK`.
7. Descargar un respaldo posterior a la migracion.

La carga inicial contiene datos reales y debe ser realizada o confirmada por el responsable del inventario; las pruebas de desarrollo no crean lotes ni movimientos reales.
