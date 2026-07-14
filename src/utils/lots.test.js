import { describe, expect, it } from 'vitest';
import {
  allocateLotsFEFO,
  formatLotTooltip,
  getAvailableLots,
  getLotOriginEditState,
  getLotOrigins,
  getLotUsage,
  isLotExpired,
  isValidExpirationDate,
  validateLotEntry,
  validateLotInitialization,
  validateLotAllocations,
} from './lots';

const MED_ID = 'fent-50';
const AS_OF = '2026-07-13';

const ingreso = (id, amount, lotNumber, expirationDate, createdAt, extra = {}) => ({
  id,
  medId: MED_ID,
  type: 'IN',
  amount,
  lotNumber,
  expirationDate,
  createdAt,
  ...extra,
});

const egreso = (id, amount, lotAllocations, extra = {}) => ({
  id,
  medId: MED_ID,
  type: 'OUT',
  amount,
  lotAllocations,
  createdAt: 10_000,
  ...extra,
});

const allocation = (sourceTransactionId, lotNumber, expirationDate, quantity) => ({
  sourceTransactionId: String(sourceTransactionId),
  lotNumber,
  expirationDate,
  quantity,
});

describe('lot dates', () => {
  it('accepts real ISO calendar dates and rejects impossible dates', () => {
    expect(isValidExpirationDate('2027-02-28')).toBe(true);
    expect(isValidExpirationDate('2027-02-29')).toBe(false);
    expect(isValidExpirationDate('31/05/2027')).toBe(false);
  });

  it('keeps a lot valid through its expiration day', () => {
    expect(isLotExpired('2026-07-13', AS_OF)).toBe(false);
    expect(isLotExpired('2026-07-12', AS_OF)).toBe(true);
  });
});

describe('lot entry validation', () => {
  it('normalizes a valid lot entry', () => {
    expect(validateLotEntry({ amount: '12', lotNumber: ' ab-123 ', expirationDate: '2027-05-31' })).toEqual({
      valid: true,
      errors: [],
      normalized: { amount: 12, lotNumber: 'AB-123', expirationDate: '2027-05-31' },
    });
  });

  it('reports every invalid required field', () => {
    expect(validateLotEntry({ amount: 1.5, lotNumber: '  ', expirationDate: '2027-02-29' }).errors).toEqual([
      'INVALID_AMOUNT',
      'MISSING_LOT_NUMBER',
      'INVALID_EXPIRATION_DATE',
    ]);
  });
});

describe('initial lot distribution', () => {
  it('accepts a distribution that exactly reconciles the current stock', () => {
    expect(validateLotInitialization([
      { lotNumber: ' a ', expirationDate: '2027-05-31', quantity: '6' },
      { lotNumber: 'B', expirationDate: '2027-08-31', quantity: 4 },
    ], 10)).toEqual({
      valid: true,
      errors: [],
      rows: [
        { lotNumber: 'A', expirationDate: '2027-05-31', quantity: 6 },
        { lotNumber: 'B', expirationDate: '2027-08-31', quantity: 4 },
      ],
      target: 10,
      total: 10,
      difference: 0,
    });
  });

  it('rejects mismatches, invalid rows, and duplicate lot/date pairs', () => {
    const result = validateLotInitialization([
      { lotNumber: 'A', expirationDate: '2027-05-31', quantity: 3 },
      { lotNumber: 'a', expirationDate: '2027-05-31', quantity: 2 },
      { lotNumber: '', expirationDate: 'bad', quantity: 0 },
    ], 10);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ROW_2:DUPLICATE_LOT');
    expect(result.errors).toContain('ROW_3:INVALID_AMOUNT');
    expect(result.errors).toContain('TOTAL_MISMATCH');
  });

  it('allows a zero-stock medication to initialize without lot rows', () => {
    expect(validateLotInitialization([], 0)).toEqual({
      valid: true, errors: [], rows: [], target: 0, total: 0, difference: 0,
    });
  });
});

describe('lot inventory', () => {
  it('recognizes regular and initialization entries as lot origins', () => {
    const items = [
      ingreso(1, 10, 'abc', '2027-05-31', 100),
      ingreso(2, 5, 'init', '2027-06-30', 200, { isLotInitialization: true, affectsGlobalStock: false }),
      { id: 3, medId: MED_ID, type: 'IN', amount: 9 },
      ingreso(4, 4, 'OTHER', '2027-07-31', 300, { medId: 'morf-15' }),
    ];
    expect(getLotOrigins(items, MED_ID)).toEqual([
      expect.objectContaining({ sourceTransactionId: '1', lotNumber: 'ABC', receivedQuantity: 10 }),
      expect.objectContaining({ sourceTransactionId: '2', lotNumber: 'INIT', receivedQuantity: 5, isLotInitialization: true }),
    ]);
  });

  it('aggregates usage by source entry', () => {
    const items = [
      egreso(10, 5, [allocation(1, 'A', '2027-05-31', 3), allocation(2, 'B', '2027-06-30', 2)]),
      egreso(11, 2, [allocation(1, 'A', '2027-05-31', 2)]),
      egreso(12, 1, [allocation(1, 'A', '2027-05-31', 1)], { medId: 'morf-15' }),
    ];
    expect(getLotUsage(items, MED_ID)).toEqual({ 1: 5, 2: 2 });
  });

  it('calculates remaining quantities without storing lotRemaining', () => {
    const items = [
      ingreso(1, 10, 'A', '2027-05-31', 100),
      ingreso(2, 4, 'B', '2027-06-30', 200),
      egreso(10, 7, [allocation(1, 'A', '2027-05-31', 7)]),
    ];
    expect(getAvailableLots(items, MED_ID, { asOf: AS_OF })).toEqual([
      expect.objectContaining({ sourceTransactionId: '1', availableQuantity: 3, usedQuantity: 7 }),
      expect.objectContaining({ sourceTransactionId: '2', availableQuantity: 4, usedQuantity: 0 }),
    ]);
  });

  it('omits exhausted and expired lots by default', () => {
    const items = [
      ingreso(1, 3, 'USED', '2027-05-31', 100),
      ingreso(2, 5, 'OLD', '2026-07-12', 200),
      ingreso(3, 4, 'LIVE', '2027-06-30', 300),
      egreso(10, 3, [allocation(1, 'USED', '2027-05-31', 3)]),
    ];
    expect(getAvailableLots(items, MED_ID, { asOf: AS_OF }).map((lot) => lot.lotNumber)).toEqual(['LIVE']);
    expect(getAvailableLots(items, MED_ID, { asOf: AS_OF, includeExpired: true }).map((lot) => lot.lotNumber)).toEqual([
      'OLD',
      'LIVE',
    ]);
  });
});

describe('FEFO allocation', () => {
  it('allocates an egreso from a single lot', () => {
    const result = allocateLotsFEFO([ingreso(1, 10, 'A', '2027-05-31', 100)], MED_ID, 4, { asOf: AS_OF });
    expect(result).toEqual(expect.objectContaining({ ok: true, requestedQuantity: 4, shortage: 0 }));
    expect(result.allocations).toEqual([allocation(1, 'A', '2027-05-31', 4)]);
  });

  it('splits an egreso across multiple lots in expiration order', () => {
    const items = [
      ingreso(1, 3, 'LATE', '2028-01-31', 100),
      ingreso(2, 5, 'FIRST', '2027-01-31', 200),
      ingreso(3, 4, 'SECOND', '2027-06-30', 300),
    ];
    expect(allocateLotsFEFO(items, MED_ID, 7, { asOf: AS_OF }).allocations).toEqual([
      allocation(2, 'FIRST', '2027-01-31', 5),
      allocation(3, 'SECOND', '2027-06-30', 2),
    ]);
  });

  it('breaks equal-expiration ties using the oldest entry', () => {
    const items = [
      ingreso('new', 5, 'SAME-NEW', '2027-05-31', 200),
      ingreso('old', 5, 'SAME-OLD', '2027-05-31', 100),
    ];
    expect(allocateLotsFEFO(items, MED_ID, 3, { asOf: AS_OF }).allocations).toEqual([
      allocation('old', 'SAME-OLD', '2027-05-31', 3),
    ]);
  });

  it('continues after partially consumed lots', () => {
    const items = [
      ingreso(1, 10, 'A', '2027-05-31', 100),
      ingreso(2, 10, 'B', '2027-06-30', 200),
      egreso(10, 8, [allocation(1, 'A', '2027-05-31', 8)]),
    ];
    expect(allocateLotsFEFO(items, MED_ID, 5, { asOf: AS_OF }).allocations).toEqual([
      allocation(1, 'A', '2027-05-31', 2),
      allocation(2, 'B', '2027-06-30', 3),
    ]);
  });

  it('reallocates an edited egreso after excluding its previous consumption', () => {
    const origin = ingreso(1, 10, 'A', '2027-05-31', 100);
    const current = egreso(10, 8, [allocation(1, 'A', '2027-05-31', 8)]);
    const historyWithoutCurrent = [origin, current].filter((item) => item.id !== current.id);
    expect(allocateLotsFEFO(historyWithoutCurrent, MED_ID, 6, { asOf: AS_OF }).allocations).toEqual([
      allocation(1, 'A', '2027-05-31', 6),
    ]);
  });

  it('blocks an egreso when stock exists only in expired lots', () => {
    const expired = ingreso(1, 10, 'EXPIRED', '2026-07-12', 100);
    expect(allocateLotsFEFO([expired], MED_ID, 1, { asOf: AS_OF })).toEqual({
      ok: false,
      code: 'INSUFFICIENT_LOT_STOCK',
      requestedQuantity: 1,
      availableQuantity: 0,
      shortage: 1,
      allocations: [],
    });
  });

  it('reports a structured shortage without making a partial assignment', () => {
    const result = allocateLotsFEFO([ingreso(1, 3, 'A', '2027-05-31', 100)], MED_ID, 5, { asOf: AS_OF });
    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_LOT_STOCK',
      requestedQuantity: 5,
      availableQuantity: 3,
      shortage: 2,
      allocations: [],
    });
  });

  it('rejects zero, negative, fractional, and nonnumeric quantities', () => {
    for (const amount of [0, -1, 1.5, 'abc']) {
      expect(allocateLotsFEFO([], MED_ID, amount, { asOf: AS_OF }).code).toBe('INVALID_AMOUNT');
    }
  });
});

describe('allocation validation', () => {
  it('accepts a consistent saved allocation', () => {
    const origin = ingreso(1, 10, 'A', '2027-05-31', 100);
    const transaction = egreso(10, 4, [allocation(1, 'A', '2027-05-31', 4)]);
    expect(validateLotAllocations([origin, transaction], transaction)).toEqual({ valid: true, errors: [] });
  });

  it('detects missing allocations and mismatched totals', () => {
    const origin = ingreso(1, 10, 'A', '2027-05-31', 100);
    expect(validateLotAllocations([origin], egreso(10, 4, []))).toEqual({
      valid: false,
      errors: ['MISSING_LOT_ALLOCATIONS', 'ALLOCATION_TOTAL_MISMATCH'],
    });
    expect(validateLotAllocations([origin], egreso(11, 4, [allocation(1, 'A', '2027-05-31', 3)])).errors).toContain(
      'ALLOCATION_TOTAL_MISMATCH',
    );
  });

  it('detects unknown origins and altered snapshots', () => {
    const origin = ingreso(1, 10, 'A', '2027-05-31', 100);
    expect(validateLotAllocations([origin], egreso(10, 2, [allocation(99, 'X', '2027-01-31', 2)])).errors).toContain(
      'UNKNOWN_LOT_ORIGIN:99',
    );
    expect(validateLotAllocations([origin], egreso(11, 2, [allocation(1, 'ALTERED', '2027-05-31', 2)])).errors).toContain(
      'LOT_SNAPSHOT_MISMATCH:1',
    );
  });

  it('detects over-allocation considering other egresos', () => {
    const origin = ingreso(1, 10, 'A', '2027-05-31', 100);
    const previous = egreso(10, 8, [allocation(1, 'A', '2027-05-31', 8)]);
    const candidate = egreso(11, 4, [allocation(1, 'A', '2027-05-31', 4)]);
    expect(validateLotAllocations([origin, previous, candidate], candidate).errors).toContain('LOT_OVERALLOCATED:1');
  });

  it('does not require lot allocations on legacy IN movements', () => {
    expect(validateLotAllocations([], ingreso(1, 10, 'A', '2027-05-31', 100))).toEqual({ valid: true, errors: [] });
  });
});

describe('lot origin edit protection', () => {
  it('allows traceability changes while an origin has no consumption', () => {
    const current = ingreso(1, 10, 'A', '2027-05-31', 100);
    expect(
      getLotOriginEditState([current], current, { medId: MED_ID, amount: 12, lotNumber: 'B', expirationDate: '2028-01-31' }),
    ).toEqual({ usedQuantity: 0, traceabilityChanged: true, allowed: true });
  });

  it('blocks traceability changes after consumption but permits non-traceability edits', () => {
    const current = ingreso(1, 10, 'A', '2027-05-31', 100);
    const use = egreso(10, 3, [allocation(1, 'A', '2027-05-31', 3)]);
    expect(
      getLotOriginEditState([current, use], current, { medId: MED_ID, amount: 11, lotNumber: 'A', expirationDate: '2027-05-31' }),
    ).toEqual({ usedQuantity: 3, traceabilityChanged: true, allowed: false });
    expect(
      getLotOriginEditState([current, use], current, { medId: MED_ID, amount: 10, lotNumber: 'a', expirationDate: '2027-05-31' }),
    ).toEqual({ usedQuantity: 3, traceabilityChanged: false, allowed: true });
  });
});

describe('lot tooltip formatter', () => {
  it('formats one or multiple saved allocations', () => {
    const transaction = egreso(10, 5, [
      allocation(1, 'A', '2027-05-31', 3),
      allocation(2, 'B', '2027-06-30', 2),
    ]);
    expect(formatLotTooltip(transaction)).toBe(
      'Lote A: 3 unidades · expira 31/05/2027\nLote B: 2 unidades · expira 30/06/2027',
    );
  });

  it('labels historical movements without traceability', () => {
    expect(formatLotTooltip(egreso(10, 2, undefined))).toBe('Registro sin trazabilidad de lote');
  });
});
