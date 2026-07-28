// Funciones puras de inventario, fechas y formato.
// Extraidas de App.jsx para poder probarlas en aislamiento (Vitest) sin React.
// No deben depender de estado de React ni de variables del componente.

// Parsea "DD/MM/YYYY HH:MM AM/PM" (formato es-CR usado en la app) a Date.
// Precision de minuto: no incluye segundos.
export const parseDateTime = (value) => {
  if (!value) return null;
  const cleaned = value
    .replace(',', '')
    .replace(/\s*a\.\s*m\.\s*$/i, ' AM')
    .replace(/\s*p\.\s*m\.\s*$/i, ' PM')
    .trim();
  const parts = cleaned.split(/\s+/);
  const datePart = parts[0];
  const timePart = parts[1] || '';
  const ampm = (parts[2] || '').toUpperCase();
  if (!datePart) return null;
  const [day, month, year] = datePart.split('/').map(Number);
  if (!day || !month || !year) return null;
  let [hour = 0, minute = 0] = (timePart || '').split(':').map(Number);
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return new Date(year, month - 1, day, hour, minute);
};

// createdAt es preciso a milisegundos; t.date solo a minutos. Priorizar
// createdAt evita empates entre un cierre y un movimiento del mismo minuto
// (que antes quedaban excluidos del inventario por el filtro > closeTime) y
// mantiene el saldo del Kardex igual al encabezado.
export const getTransactionTimestamp = (t) => {
  if (Number.isFinite(t?.createdAt)) return t.createdAt;
  const fromDate = parseDateTime(t?.date)?.getTime();
  if (Number.isFinite(fromDate)) return fromDate;
  return 0;
};

export const compareTransactionsAsc = (a, b) => {
  const aDate = getTransactionTimestamp(a);
  const bDate = getTransactionTimestamp(b);
  if (aDate !== bDate) return aDate - bDate;
  const aCreated = Number.isFinite(a?.createdAt) ? a.createdAt : 0;
  const bCreated = Number.isFinite(b?.createdAt) ? b.createdAt : 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  const aId = Number(a?.id) || 0;
  const bId = Number(b?.id) || 0;
  return aId - bId;
};

export const compareTransactionsDesc = (a, b) => compareTransactionsAsc(b, a);

// Timestamp para la CLASIFICACION VISUAL del Kardex (ventana "Recientes" vs
// "Historico anteriores a 7 dias"). A diferencia de getTransactionTimestamp
// (que prioriza createdAt para ORDEN y CALCULO de saldo), aqui priorizamos la
// fecha MOSTRADA `date`. Asi un movimiento con fecha visible reciente nunca cae
// al historico oculto aunque su createdAt haya quedado desfasado respecto a
// `date` (registros viejos editados con la version antigua). No usar para
// ordenar ni para calcular stock: solo para decidir en que tabla se muestra.
export const getDisplayTimestamp = (t) => {
  const fromDate = parseDateTime(t?.date)?.getTime();
  if (Number.isFinite(fromDate)) return fromDate;
  if (Number.isFinite(t?.createdAt)) return t.createdAt;
  return 0;
};

// Une dos listas de movimientos deduplicando por id (gana el de `incoming`).
// Se usa al fusionar la carga completa por medicamento con lo ya cargado
// globalmente, sin introducir duplicados. No ordena: cada consumidor ordena.
export const mergeTransactionsById = (prev, incoming) => {
  const byId = new Map((prev || []).map((t) => [String(t?.id), t]));
  (incoming || []).forEach((t) => {
    if (t == null) return;
    byId.set(String(t.id), t);
  });
  return Array.from(byId.values());
};

// Ultima ancla de saldo (cierre o ajuste manual) de un medicamento.
export const getLastBalanceAnchor = (items, medId) =>
  items
    .filter((t) => t.medId === medId && t.isCierre)
    .sort(compareTransactionsDesc)[0];

// Turno de cierre que congela el historial. Solo el cierre de 24 horas corta el
// periodo contable; los cierres de turno (primero, segundo, tercero) no bloquean.
export const CLOSURE_24H_TURNO = 'CIERRE 24 HORAS';

export const isClosure24h = (t) => Boolean(t?.isCierre) && t?.cierreTurno === CLOSURE_24H_TURNO;

// Mapa medId -> timestamp del ultimo CIERRE 24 HORAS de ese medicamento.
// Ese timestamp es el "cutoff" del medicamento: todo movimiento suyo con
// timestamp <= cutoff queda congelado (no se puede editar ni eliminar).
// El bloqueo es POR MEDICAMENTO: cerrar FENTANYL no congela MORFINA.
export const getClosureCutoffByMedId = (transactions) => {
  const map = {};
  (transactions || []).forEach((t) => {
    if (!t?.medId || !isClosure24h(t)) return;
    const ts = getTransactionTimestamp(t);
    if (!Number.isFinite(ts)) return;
    if (map[t.medId] === undefined || ts > map[t.medId]) map[t.medId] = ts;
  });
  return map;
};

// Fusiona los cutoffs calculados desde los movimientos en memoria con los
// persistidos en Firestore (coleccion closureLocks). Se queda con el mayor de
// los dos: la ventana de movimientos cargados puede no incluir un cierre viejo,
// y en ese caso el valor persistido es el unico que conoce el corte real.
export const mergeClosureCutoffs = (computed, stored) => {
  const merged = { ...(computed || {}) };
  Object.entries(stored || {}).forEach(([medId, value]) => {
    const cutoff = Number(value);
    if (!Number.isFinite(cutoff)) return;
    if (merged[medId] === undefined || cutoff > merged[medId]) merged[medId] = cutoff;
  });
  return merged;
};

// Un movimiento esta congelado si su medicamento tiene un cierre de 24 horas
// con timestamp mayor o igual al suyo. La comparacion es <= (y no <) a proposito:
// asi el cierre mismo queda incluido y tampoco se puede borrar, que es lo que
// protege el ancla de saldo.
export const isTransactionLocked = (t, cutoffByMedId) => {
  if (!t?.medId) return false;
  const cutoff = cutoffByMedId?.[t.medId];
  if (!Number.isFinite(cutoff)) return false;
  return getTransactionTimestamp(t) <= cutoff;
};

// Cuantos movimientos congelados tiene un medicamento. Se usa para explicarle
// al usuario por que no puede eliminarlo.
export const countLockedTransactions = (transactions, medId, cutoffByMedId) =>
  (transactions || []).filter((t) => t?.medId === medId && isTransactionLocked(t, cutoffByMedId)).length;

// Calcula el stock actual de un medicamento: parte de la ultima ancla de saldo
// y suma/resta los movimientos posteriores a ella. Misma logica que el inventario
// que se muestra en pantalla. Devuelve un entero (puede ser negativo).
export const computeMedStock = (transactions, medId) => {
  const lastAnchor = getLastBalanceAnchor(transactions, medId);
  const closeTime = lastAnchor ? getTransactionTimestamp(lastAnchor) : null;
  const baseStock = Number(lastAnchor?.totalMedicamento) || 0;
  const periodTransactions = transactions.filter(
    (t) =>
      t.medId === medId &&
      !t.isCierre &&
      t.affectsGlobalStock !== false &&
      (closeTime === null || getTransactionTimestamp(t) > closeTime),
  );
  return periodTransactions.reduce(
    (acc, t) => (t.type === 'IN' ? acc + (Number(t.amount) || 0) : acc - (Number(t.amount) || 0)),
    baseStock,
  );
};

// Progreso de uso de una receta ABIERTA: dado el conjunto de movimientos,
// calcula cuanto quedaria usado tras agregar `amountToAdd`, sin exceder rxQuantity.
export const nextOpenRxUse = (items, medId, prescription, rxQuantity, amountToAdd = 1) => {
  const matches = items.filter(
    (t) => t.medId === medId && t.rxType === 'ABIERTA' && t.prescription === prescription && t.rxQuantity === rxQuantity,
  );
  const safeAmount = Math.max(0, Number(amountToAdd) || 0);
  if (matches.length === 0) return Math.min(safeAmount, rxQuantity);
  const maxUsed = Math.max(...matches.map((t) => t.rxUsed || 0));
  return Math.min(maxUsed + safeAmount, rxQuantity);
};

// Cantidad a reponer para alcanzar la cuota, dado el stock al cierre.
// Nunca negativa (si el stock supera la cuota, no hay que reponer).
export const computeTotalReponer = (quota, currentStockAtClose) =>
  Math.max(0, (Number(quota) || 0) - (Number(currentStockAtClose) || 0));

export const formatCurrency = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const parseCurrency = (value) => {
  if (value === null || value === undefined) return 0;
  const cleaned = value.toString().replace(/\s/g, '');
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : 0;
};
