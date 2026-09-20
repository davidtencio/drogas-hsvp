import { describe, expect, it } from 'vitest';
import { getLotInventorySummary } from './lots';
import { buildLotStockReport, formatLotStatus } from './lotReport';

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

const egreso = (id, amount, lotAllocations) => ({
  id,
  medId: MED_ID,
  type: 'OUT',
  amount,
  lotAllocations,
  createdAt: 5000,
});

// Vencido, por vencer (19 dias) y vigente, con un lote agotado y un mismo lote
// fisico (B2 con igual expiracion) recibido en dos ingresos distintos.
const transactions = [
  ingreso('1', 10, 'A1', '2026-06-01', 1000),
  ingreso('2', 12, 'B2', '2026-08-01', 2000),
  ingreso('3', 8, 'B2', '2026-08-01', 2500),
  ingreso('4', 30, 'C3', '2027-01-01', 3000, { isLotInitialization: true }),
  ingreso('5', 5, 'D4', '2027-06-01', 4000),
  egreso('6', 5, [{ sourceTransactionId: '5', lotNumber: 'D4', expirationDate: '2027-06-01', quantity: 5 }]),
];

const entryFor = (overrides = {}) => ({
  medId: MED_ID,
  medName: 'FENTANYL 50 MCG',
  initialized: true,
  globalStock: 60,
  summary: getLotInventorySummary(transactions, MED_ID, { asOf: AS_OF }),
  ...overrides,
});

describe('buildLotStockReport', () => {
  it('ordena los lotes en FEFO y clasifica vencido, por vencer y vigente', () => {
    const { sections } = buildLotStockReport([entryFor()], { asOf: AS_OF });
    const [section] = sections;
    expect(section.lots.map((lot) => lot.lotNumber)).toEqual(['A1', 'B2', 'C3']);
    expect(section.lots[0]).toMatchObject({ expired: true, expiringSoon: false, daysLeft: -42 });
    expect(section.lots[1]).toMatchObject({ expired: false, expiringSoon: true, daysLeft: 19 });
    expect(section.lots[2]).toMatchObject({ expired: false, expiringSoon: false, daysLeft: 172 });
  });

  it('agrupa en un solo renglon el lote fisico recibido en varios ingresos', () => {
    const { sections } = buildLotStockReport([entryFor()], { asOf: AS_OF });
    const b2 = sections[0].lots.filter((lot) => lot.lotNumber === 'B2');
    expect(b2).toHaveLength(1);
    expect(b2[0]).toMatchObject({ quantity: 20, originCount: 2 });
    // Tres lotes fisicos a partir de cuatro ingresos con existencia.
    expect(sections[0].lotCount).toBe(3);
    expect(sections[0].originCount).toBe(4);
  });

  it('excluye los lotes agotados salvo que se pidan', () => {
    const visible = buildLotStockReport([entryFor()], { asOf: AS_OF });
    expect(visible.sections[0].lots.map((lot) => lot.lotNumber)).not.toContain('D4');

    const conAgotados = buildLotStockReport([entryFor()], { asOf: AS_OF, includeDepleted: true });
    expect(conAgotados.sections[0].lots.map((lot) => lot.lotNumber)).toContain('D4');
    // Un lote agotado no cambia los totales de existencia.
    expect(conAgotados.totals.available).toBe(visible.totals.available);
    expect(conAgotados.totals.lots).toBe(visible.totals.lots);
  });

  it('la suma de los lotes del renglon es la existencia del medicamento', () => {
    const { sections } = buildLotStockReport([entryFor()], { asOf: AS_OF });
    const suma = sections[0].lots.reduce((acc, lot) => acc + lot.quantity, 0);
    expect(suma).toBe(sections[0].totalAvailable);
    expect(suma).toBe(sections[0].globalStock);
  });

  it('marca el descuadre cuando el saldo actual no coincide con los lotes', () => {
    const cuadrado = buildLotStockReport([entryFor()], { asOf: AS_OF });
    expect(cuadrado.sections[0].matches).toBe(true);
    expect(cuadrado.totals.mismatches).toBe(0);

    const descuadrado = buildLotStockReport([entryFor({ globalStock: 61 })], { asOf: AS_OF });
    expect(descuadrado.sections[0].matches).toBe(false);
    expect(descuadrado.totals.mismatches).toBe(1);
  });

  it('no declara cuadrado un medicamento que no se pudo cargar', () => {
    const { sections, totals } = buildLotStockReport(
      [{ medId: 'morf-15', medName: 'MORFINA 15 MG', failed: true }],
      { asOf: AS_OF },
    );
    expect(sections[0].matches).toBe(false);
    expect(totals.failures).toBe(1);
    // Un medicamento sin historial confirmado no aporta cifras a los totales.
    expect(totals.available).toBe(0);
    expect(totals.mismatches).toBe(0);
  });

  it('suma los totales del reporte por medicamento', () => {
    const { totals } = buildLotStockReport(
      [entryFor(), entryFor({ medId: 'morf-15', medName: 'MORFINA 15 MG', globalStock: 60 })],
      { asOf: AS_OF },
    );
    expect(totals).toMatchObject({
      medications: 2,
      globalStock: 120,
      available: 120,
      usable: 100,
      expired: 20,
      lots: 6,
      expiredLots: 2,
      expiringSoonLots: 2,
      mismatches: 0,
      failures: 0,
    });
  });

  it('tolera una lista vacia', () => {
    const { sections, totals } = buildLotStockReport([], { asOf: AS_OF });
    expect(sections).toEqual([]);
    expect(totals).toMatchObject({ medications: 0, available: 0, lots: 0 });
  });
});

describe('formatLotStatus', () => {
  it('describe el estado con el mismo texto de la tarjeta', () => {
    expect(formatLotStatus({ expired: true, daysLeft: -42 })).toBe('Vencido hace 42 d');
    expect(formatLotStatus({ expired: false, daysLeft: 0 })).toBe('Vence hoy');
    expect(formatLotStatus({ expired: false, daysLeft: 19 })).toBe('Vence en 19 d');
    expect(formatLotStatus({ expired: true, daysLeft: null })).toBe('Sin fecha');
  });
});
