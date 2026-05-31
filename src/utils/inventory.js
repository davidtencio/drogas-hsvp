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

// Ultima ancla de saldo (cierre o ajuste manual) de un medicamento.
export const getLastBalanceAnchor = (items, medId) =>
  items
    .filter((t) => t.medId === medId && t.isCierre)
    .sort(compareTransactionsDesc)[0];

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
      (closeTime === null || getTransactionTimestamp(t) > closeTime),
  );
  return periodTransactions.reduce(
    (acc, t) => (t.type === 'IN' ? acc + (Number(t.amount) || 0) : acc - (Number(t.amount) || 0)),
    baseStock,
  );
};

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
