# Historial compartido por medicamento (2026-09-06)

## Problema y cambio

Cada llamada a `prepareLotAllocations` descargaba todos los movimientos del
medicamento mediante páginas de 500. La corrección anterior del scroll no
eliminó esa descarga en cada salida.

Ahora `loadAllForMed` reutiliza una suscripción `onSnapshot` por medicamento y
sesión autenticada. El primer acceso todavía carga el historial completo;
después Firestore transmite cambios. La consulta usa `medId` sin `orderBy`,
por lo que también incluye registros antiguos sin `createdAt`. Los cálculos
continúan ordenando en memoria con las funciones existentes.

La suscripción espera `fromCache === false` y `hasPendingWrites === false`.
Las verificaciones esperan como máximo 15 segundos si no existe una respuesta
confirmada. Desconexión detectada, error o cierre de sesión invalidan la copia.
Los cambios se reemplazan por medicamento para reflejar también eliminaciones;
la cola local pendiente se aplica sobre esa vista sin perder otros medicamentos.
Las actualizaciones React usan el estado más reciente para no sobrescribir
cambios recibidos mientras una operación esperaba.

## Verificación y medición

El log de sincronización muestra contadores de la sesión: suscripciones,
documentos iniciales, cambios, eliminaciones y reutilizaciones. No contienen
datos de pacientes y no generan escrituras de telemetría en Firestore.
Son observaciones del cliente, no una reconstrucción de la factura. Otras
consultas, mínimos, reconexiones y otros equipos no están incluidos.

En las pruebas, 100 verificaciones de 2.000 documentos comparten una sola
suscripción. También se verifican cambios remotos en FEFO, eliminaciones,
pendientes, cache incompleta, timeout, reconexión y finalización de sesión.

La prueba de integración adicional usa dos clientes autenticados, las reglas
actuales y 2.000 documentos ficticios en los emuladores de Auth y Firestore:

```
firebase emulators:exec --only auth,firestore --project demo-drogas-read-tests --config firebase.emulators.json "node tests/firestore-live-history.integration.mjs"
```

Requiere Java 21. El script rechaza cualquier proyecto o dirección de servidor
que no corresponda al emulador local indicado.

Para contrastar el resultado real, recargar las sesiones abiertas después de
publicar y comparar varios días completos en Firebase con actividad similar.
El día del despliegue incluye consumo de la versión anterior. No se promete
un costo de cero ni un porcentaje de ahorro basándose solamente en pruebas.

## Límites

- Cada equipo/sesión realiza su carga inicial; una reconexión puede volver a
  facturarla. No se habilita persistencia de datos clínicos en disco.
- Los listeners entregan cambios en tiempo real, pero no convierten la
  asignación FEFO y su escritura posterior en una transacción atómica. Dos
  usuarios que actúan simultáneamente conservan el riesgo de concurrencia
  previo; resolverlo requiere otro cambio en la operación de escritura.
- Se conservan el historial y las reglas. No se migran saldos ni se crean
  documentos resumidos. La arquitectura de resumen por lote sigue siendo
  una alternativa si las cargas iniciales resultan dominantes.

Referencias: https://firebase.google.com/docs/firestore/query-data/listen y
https://firebase.google.com/docs/firestore/pricing
