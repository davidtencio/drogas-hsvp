import { getTransactionTimestamp } from './inventory';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isPositiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

export const validateLotEntry = ({ amount, lotNumber, expirationDate } = {}) => {
  const errors = [];
  const normalized = {
    amount: Number(amount),
    lotNumber: lotNumber?.toString().trim().toUpperCase() || '',
    expirationDate: expirationDate?.toString() || '',
  };
  if (!isPositiveInteger(normalized.amount)) errors.push('INVALID_AMOUNT');
  if (!normalized.lotNumber) errors.push('MISSING_LOT_NUMBER');
  if (!isValidExpirationDate(normalized.expirationDate)) errors.push('INVALID_EXPIRATION_DATE');
  return { valid: errors.length === 0, errors, normalized };
};

export const validateLotInitialization = (rows, targetStock) => {
  const target = Number(targetStock);
  const normalizedRows = [];
  const errors = [];
  const seen = new Set();
  (rows || []).forEach((row, index) => {
    const validation = validateLotEntry({
      amount: row?.quantity,
      lotNumber: row?.lotNumber,
      expirationDate: row?.expirationDate,
    });
    if (!validation.valid) {
      validation.errors.forEach((error) => errors.push(`ROW_${index + 1}:${error}`));
      return;
    }
    const normalized = {
      lotNumber: validation.normalized.lotNumber,
      expirationDate: validation.normalized.expirationDate,
      quantity: validation.normalized.amount,
    };
    const key = `${normalized.lotNumber}|${normalized.expirationDate}`;
    if (seen.has(key)) errors.push(`ROW_${index + 1}:DUPLICATE_LOT`);
    seen.add(key);
    normalizedRows.push(normalized);
  });
  if (!Number.isInteger(target) || target < 0) errors.push('INVALID_TARGET_STOCK');
  if (target > 0 && normalizedRows.length === 0) errors.push('MISSING_LOTS');
  const total = normalizedRows.reduce((sum, row) => sum + row.quantity, 0);
  const difference = target - total;
  if (Number.isFinite(target) && difference !== 0) errors.push('TOTAL_MISMATCH');
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), rows: normalizedRows, target, total, difference };
};

const toDateKey = (value = new Date()) => {
  if (typeof value === 'string' && ISO_DATE_PATTERN.test(value.slice(0, 10))) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const isValidExpirationDate = (value) => {
  if (!ISO_DATE_PATTERN.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
};

// Un lote vence al finalizar la fecha indicada. Durante el propio día de
// expiración todavía se considera vigente para el ordenamiento FEFO.
export const isLotExpired = (expirationDate, asOf = new Date()) => {
  if (!isValidExpirationDate(expirationDate)) return true;
  const referenceDate = toDateKey(asOf);
  return !referenceDate || expirationDate < referenceDate;
};

// Dias calendario que faltan para la expiracion. Cero significa que vence hoy
// (todavia vigente segun isLotExpired) y los negativos ya estan vencidos.
export const getDaysUntilExpiration = (expirationDate, asOf = new Date()) => {
  if (!isValidExpirationDate(expirationDate)) return null;
  const referenceKey = toDateKey(asOf);
  if (!referenceKey) return null;
  const [expirationYear, expirationMonth, expirationDay] = expirationDate.split('-').map(Number);
  const [referenceYear, referenceMonth, referenceDay] = referenceKey.split('-').map(Number);
  const expiration = Date.UTC(expirationYear, expirationMonth - 1, expirationDay);
  const reference = Date.UTC(referenceYear, referenceMonth - 1, referenceDay);
  return Math.round((expiration - reference) / 86400000);
};

export const getLotOrigins = (transactions, medId) =>
  (transactions || [])
    .filter(
      (item) =>
        item?.medId === medId &&
        item?.type === 'IN' &&
        isPositiveInteger(item?.amount) &&
        Boolean(item?.lotNumber?.toString().trim()) &&
        isValidExpirationDate(item?.expirationDate),
    )
    .map((item) => ({
      sourceTransactionId: String(item.id),
      medId: item.medId,
      lotNumber: item.lotNumber.toString().trim().toUpperCase(),
      expirationDate: item.expirationDate,
      receivedQuantity: Number(item.amount),
      createdAt: getTransactionTimestamp(item),
      isLotInitialization: Boolean(item.isLotInitialization),
      isLotAdjustment: Boolean(item.isLotAdjustment),
    }));

export const getLotUsage = (transactions, medId) => {
  const usage = {};
  (transactions || []).forEach((transaction) => {
    if (transaction?.medId !== medId || transaction?.type !== 'OUT') return;
    (transaction.lotAllocations || []).forEach((allocation) => {
      if (!allocation?.sourceTransactionId || !isPositiveInteger(allocation?.quantity)) return;
      const sourceId = String(allocation.sourceTransactionId);
      usage[sourceId] = (usage[sourceId] || 0) + Number(allocation.quantity);
    });
  });
  return usage;
};

export const getLotOriginEditState = (transactions, current, next) => {
  if (!current || current.type !== 'IN') return { usedQuantity: 0, traceabilityChanged: false, allowed: true };
  const usedQuantity = getLotUsage(transactions, current.medId)[String(current.id)] || 0;
  const traceabilityChanged =
    next.medId !== current.medId ||
    Number(next.amount) !== Number(current.amount) ||
    next.lotNumber?.toString().trim().toUpperCase() !== current.lotNumber?.toString().trim().toUpperCase() ||
    next.expirationDate !== current.expirationDate;
  return { usedQuantity, traceabilityChanged, allowed: usedQuantity === 0 || !traceabilityChanged };
};

export const compareLotsFEFO = (a, b) => {
  const expirationComparison = a.expirationDate.localeCompare(b.expirationDate);
  if (expirationComparison !== 0) return expirationComparison;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.sourceTransactionId.localeCompare(b.sourceTransactionId);
};

export const getAvailableLots = (transactions, medId, { asOf = new Date(), includeExpired = false } = {}) => {
  const usage = getLotUsage(transactions, medId);
  return getLotOrigins(transactions, medId)
    .map((origin) => {
      const usedQuantity = usage[origin.sourceTransactionId] || 0;
      return {
        ...origin,
        usedQuantity,
        availableQuantity: Math.max(0, origin.receivedQuantity - usedQuantity),
        expired: isLotExpired(origin.expirationDate, asOf),
      };
    })
    .filter((lot) => lot.availableQuantity > 0 && (includeExpired || !lot.expired))
    .sort(compareLotsFEFO);
};

export const getLotInventorySummary = (transactions, medId, { asOf = new Date() } = {}) => {
  const usage = getLotUsage(transactions, medId);
  const lots = getLotOrigins(transactions, medId).map((origin) => {
    const usedQuantity = usage[origin.sourceTransactionId] || 0;
    const availableQuantity = Math.max(0, origin.receivedQuantity - usedQuantity);
    return {
      ...origin,
      usedQuantity,
      availableQuantity,
      expired: isLotExpired(origin.expirationDate, asOf),
    };
  });
  const availableLots = lots.filter((lot) => lot.availableQuantity > 0);
  const totalAvailable = availableLots.reduce((sum, lot) => sum + lot.availableQuantity, 0);
  const expiredAvailable = availableLots
    .filter((lot) => lot.expired)
    .reduce((sum, lot) => sum + lot.availableQuantity, 0);
  return {
    lots,
    lotCount: availableLots.length,
    totalAvailable,
    usableAvailable: totalAvailable - expiredAvailable,
    expiredAvailable,
  };
};

export const allocateLotsFEFO = (transactions, medId, amount, { asOf = new Date() } = {}) => {
  const requestedQuantity = Number(amount);
  if (!isPositiveInteger(requestedQuantity)) {
    return { ok: false, code: 'INVALID_AMOUNT', requestedQuantity, availableQuantity: 0, shortage: 0, allocations: [] };
  }
  const lots = getAvailableLots(transactions, medId, { asOf });
  const availableQuantity = lots.reduce((sum, lot) => sum + lot.availableQuantity, 0);
  if (availableQuantity < requestedQuantity) {
    return {
      ok: false,
      code: 'INSUFFICIENT_LOT_STOCK',
      requestedQuantity,
      availableQuantity,
      shortage: requestedQuantity - availableQuantity,
      allocations: [],
    };
  }
  let remaining = requestedQuantity;
  const allocations = [];
  for (const lot of lots) {
    if (remaining === 0) break;
    const quantity = Math.min(remaining, lot.availableQuantity);
    allocations.push({
      sourceTransactionId: lot.sourceTransactionId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      quantity,
    });
    remaining -= quantity;
  }
  return { ok: true, code: null, requestedQuantity, availableQuantity, shortage: 0, allocations };
};

export const validateLotAllocations = (transactions, transaction) => {
  const errors = [];
  if (!transaction || transaction.type !== 'OUT') return { valid: true, errors };
  const amount = Number(transaction.amount);
  const allocations = Array.isArray(transaction.lotAllocations) ? transaction.lotAllocations : [];
  if (!isPositiveInteger(amount)) errors.push('INVALID_TRANSACTION_AMOUNT');
  if (allocations.length === 0) errors.push('MISSING_LOT_ALLOCATIONS');

  const otherTransactions = (transactions || []).filter((item) => String(item?.id) !== String(transaction.id));
  const origins = new Map(getLotOrigins(otherTransactions, transaction.medId).map((origin) => [origin.sourceTransactionId, origin]));
  const existingUsage = getLotUsage(otherTransactions, transaction.medId);
  const requestedByOrigin = {};

  allocations.forEach((allocation) => {
    const sourceId = String(allocation?.sourceTransactionId || '');
    if (!sourceId || !isPositiveInteger(allocation?.quantity)) {
      errors.push('INVALID_ALLOCATION');
      return;
    }
    const origin = origins.get(sourceId);
    if (!origin) {
      errors.push(`UNKNOWN_LOT_ORIGIN:${sourceId}`);
      return;
    }
    if (allocation.lotNumber !== origin.lotNumber || allocation.expirationDate !== origin.expirationDate) {
      errors.push(`LOT_SNAPSHOT_MISMATCH:${sourceId}`);
    }
    requestedByOrigin[sourceId] = (requestedByOrigin[sourceId] || 0) + Number(allocation.quantity);
  });

  const allocatedQuantity = allocations.reduce(
    (sum, allocation) => sum + (isPositiveInteger(allocation?.quantity) ? Number(allocation.quantity) : 0),
    0,
  );
  if (allocatedQuantity !== amount) errors.push('ALLOCATION_TOTAL_MISMATCH');

  Object.entries(requestedByOrigin).forEach(([sourceId, quantity]) => {
    const origin = origins.get(sourceId);
    if (origin && (existingUsage[sourceId] || 0) + quantity > origin.receivedQuantity) {
      errors.push(`LOT_OVERALLOCATED:${sourceId}`);
    }
  });
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)) };
};

// Agrupa los origenes por lote fisico (numero + expiracion) sumando lo
// disponible. El motor rastrea un origen por ingreso, pero en el estante un
// mismo lote ingresado en varias fechas es UN solo lote: el recuento se declara
// asi, y ademas planLotRecount rechaza filas repetidas con la misma llave.
export const condenseLotsByIdentity = (lots) => {
  const condensed = [];
  const indexByKey = new Map();
  (lots || []).forEach((lot) => {
    const key = `${lot?.lotNumber}|${lot?.expirationDate}`;
    const existing = indexByKey.get(key);
    const quantity = Number(lot?.availableQuantity) || 0;
    if (existing !== undefined) {
      condensed[existing].quantity += quantity;
      condensed[existing].originCount += 1;
      return;
    }
    indexByKey.set(key, condensed.length);
    condensed.push({
      lotNumber: lot?.lotNumber,
      expirationDate: lot?.expirationDate,
      quantity,
      originCount: 1,
    });
  });
  return condensed;
};

// Recuento fisico de un medicamento ya inicializado. La suma de las filas ES el
// saldo nuevo: no se digita aparte. Devuelve ademas las asignaciones que liberan
// TODA la existencia por lote vigente, porque un ancla de saldo corta el calculo
// global por tiempo pero los origenes de lote se acumulan sobre toda la historia:
// sin esa liberacion los lotes viejos seguirian contando y el ajuste descuadraria.
// Un recuento sin filas es el ajuste a cero y es valido: no exige lote ni fecha.
export const planLotRecount = (transactions, medId, rows, { asOf = new Date() } = {}) => {
  const errors = [];
  const normalizedRows = [];
  const seen = new Set();
  (rows || []).forEach((row, index) => {
    const validation = validateLotEntry({
      amount: row?.quantity,
      lotNumber: row?.lotNumber,
      expirationDate: row?.expirationDate,
    });
    if (!validation.valid) {
      validation.errors.forEach((error) => errors.push(`ROW_${index + 1}:${error}`));
      return;
    }
    const normalized = {
      lotNumber: validation.normalized.lotNumber,
      expirationDate: validation.normalized.expirationDate,
      quantity: validation.normalized.amount,
    };
    const key = `${normalized.lotNumber}|${normalized.expirationDate}`;
    if (seen.has(key)) errors.push(`ROW_${index + 1}:DUPLICATE_LOT`);
    seen.add(key);
    normalizedRows.push(normalized);
  });
  const currentLots = getAvailableLots(transactions, medId, { asOf, includeExpired: true });
  const currentLotStock = currentLots.reduce((sum, lot) => sum + lot.availableQuantity, 0);
  const newTotal = normalizedRows.reduce((sum, row) => sum + row.quantity, 0);
  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    rows: normalizedRows,
    newTotal,
    currentLotStock,
    difference: newTotal - currentLotStock,
    releaseAllocations: currentLots.map((lot) => ({
      sourceTransactionId: lot.sourceTransactionId,
      lotNumber: lot.lotNumber,
      expirationDate: lot.expirationDate,
      quantity: lot.availableQuantity,
    })),
  };
};

// Correccion de digitacion de un lote: cambia numero y/o fecha sin tocar
// cantidades, por lo que no altera el saldo global. Los egresos guardaron una
// copia del lote en lotAllocations, asi que devuelve tambien esos movimientos ya
// reescritos; de lo contrario el historico conservaria el dato erroneo y
// validateLotAllocations lo marcaria como LOT_SNAPSHOT_MISMATCH.
export const planLotCorrection = (transactions, medId, sourceTransactionId, { lotNumber, expirationDate } = {}) => {
  const errors = [];
  const sourceId = String(sourceTransactionId || '');
  const origin = getLotOrigins(transactions, medId).find((item) => item.sourceTransactionId === sourceId) || null;
  const nextLotNumber = lotNumber?.toString().trim().toUpperCase() || '';
  const nextExpirationDate = expirationDate?.toString() || '';
  if (!origin) errors.push('UNKNOWN_LOT_ORIGIN');
  if (!nextLotNumber) errors.push('MISSING_LOT_NUMBER');
  if (!isValidExpirationDate(nextExpirationDate)) errors.push('INVALID_EXPIRATION_DATE');
  if (origin && origin.lotNumber === nextLotNumber && origin.expirationDate === nextExpirationDate) {
    errors.push('NO_CHANGES');
  }
  const affectedTransactions =
    errors.length > 0
      ? []
      : (transactions || [])
          .filter(
            (item) =>
              item?.medId === medId &&
              item?.type === 'OUT' &&
              (item.lotAllocations || []).some((allocation) => String(allocation?.sourceTransactionId) === sourceId),
          )
          .map((item) => ({
            id: item.id,
            lotAllocations: item.lotAllocations.map((allocation) =>
              String(allocation?.sourceTransactionId) === sourceId
                ? { ...allocation, lotNumber: nextLotNumber, expirationDate: nextExpirationDate }
                : allocation,
            ),
          }));
  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    origin,
    lotNumber: nextLotNumber,
    expirationDate: nextExpirationDate,
    affectedTransactions,
  };
};

export const formatLotExpirationDate = (value) => {
  if (!isValidExpirationDate(value)) return value || 'SIN FECHA';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
};

export const formatLotTooltip = (transaction) => {
  const allocations = Array.isArray(transaction?.lotAllocations) ? transaction.lotAllocations : [];
  if (allocations.length === 0) return 'Registro sin trazabilidad de lote';
  return allocations
    .map(
      (allocation) =>
        `Lote ${allocation.lotNumber || 'SIN IDENTIFICAR'}: ${Number(allocation.quantity) || 0} unidades · expira ${formatLotExpirationDate(allocation.expirationDate)}`,
    )
    .join('\n');
};
