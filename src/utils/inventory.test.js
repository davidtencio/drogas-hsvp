import { describe, it, expect } from 'vitest';
import {
  parseDateTime,
  getTransactionTimestamp,
  compareTransactionsAsc,
  getLastBalanceAnchor,
  computeMedStock,
  formatCurrency,
  parseCurrency,
} from './inventory';

describe('parseDateTime', () => {
  it('parsea formato es-CR con AM/PM', () => {
    const d = parseDateTime('27/08/2025 1:34 PM');
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(7); // agosto = 7
    expect(d.getDate()).toBe(27);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(34);
  });

  it('convierte 12 AM a medianoche y 12 PM a mediodia', () => {
    expect(parseDateTime('01/01/2025 12:00 AM').getHours()).toBe(0);
    expect(parseDateTime('01/01/2025 12:00 PM').getHours()).toBe(12);
  });

  it('devuelve null para valores invalidos', () => {
    expect(parseDateTime('')).toBeNull();
    expect(parseDateTime(null)).toBeNull();
    expect(parseDateTime('texto')).toBeNull();
  });
});

describe('getTransactionTimestamp (#1)', () => {
  it('prioriza createdAt (ms) sobre date (minuto)', () => {
    const t = { createdAt: 1700000000123, date: '01/01/2020 10:00 AM' };
    expect(getTransactionTimestamp(t)).toBe(1700000000123);
  });

  it('cae a date cuando no hay createdAt', () => {
    const t = { date: '27/08/2025 1:34 PM' };
    expect(getTransactionTimestamp(t)).toBe(parseDateTime('27/08/2025 1:34 PM').getTime());
  });

  it('devuelve 0 cuando no hay ni createdAt ni date', () => {
    expect(getTransactionTimestamp({})).toBe(0);
  });
});

describe('compareTransactionsAsc', () => {
  it('ordena por timestamp ascendente', () => {
    const a = { createdAt: 100 };
    const b = { createdAt: 200 };
    expect(compareTransactionsAsc(a, b)).toBeLessThan(0);
    expect(compareTransactionsAsc(b, a)).toBeGreaterThan(0);
  });

  it('desempata por id cuando el timestamp es igual', () => {
    const a = { createdAt: 100, id: 1 };
    const b = { createdAt: 100, id: 2 };
    expect(compareTransactionsAsc(a, b)).toBeLessThan(0);
  });
});

describe('getLastBalanceAnchor', () => {
  it('devuelve el cierre mas reciente del medicamento', () => {
    const txs = [
      { id: 1, medId: 'm', isCierre: true, createdAt: 100, totalMedicamento: 50 },
      { id: 2, medId: 'm', isCierre: true, createdAt: 300, totalMedicamento: 80 },
      { id: 3, medId: 'm', createdAt: 200, type: 'OUT', amount: 5 },
    ];
    expect(getLastBalanceAnchor(txs, 'm').id).toBe(2);
  });

  it('ignora anclas de otros medicamentos', () => {
    const txs = [{ id: 1, medId: 'otro', isCierre: true, createdAt: 100 }];
    expect(getLastBalanceAnchor(txs, 'm')).toBeUndefined();
  });
});

describe('computeMedStock', () => {
  it('suma ingresos y resta egresos sin ancla', () => {
    const txs = [
      { medId: 'm', type: 'IN', amount: 100, createdAt: 1 },
      { medId: 'm', type: 'OUT', amount: 30, createdAt: 2 },
    ];
    expect(computeMedStock(txs, 'm')).toBe(70);
  });

  it('parte del totalMedicamento del ancla, ignorando lo anterior (#3)', () => {
    const txs = [
      { medId: 'm', type: 'IN', amount: 100, createdAt: 1 },
      { medId: 'm', type: 'OUT', amount: 30, createdAt: 2 },
      // ajuste manual fija el saldo en 50 (no la suma pura 70)
      { medId: 'm', isCierre: true, totalMedicamento: 50, createdAt: 3 },
      { medId: 'm', type: 'OUT', amount: 10, createdAt: 4 },
    ];
    // 50 (ancla) - 10 = 40, NO 70 - 10
    expect(computeMedStock(txs, 'm')).toBe(40);
  });

  it('incluye un movimiento del mismo minuto que el cierre via createdAt (#1)', () => {
    const txs = [
      { medId: 'm', isCierre: true, totalMedicamento: 95, createdAt: 1000, date: '01/01/2025 10:00 AM' },
      // mismo minuto que el cierre pero posterior (createdAt mayor)
      { medId: 'm', type: 'OUT', amount: 3, createdAt: 1001, date: '01/01/2025 10:00 AM' },
    ];
    // el OUT debe restarse: 95 - 3 = 92
    expect(computeMedStock(txs, 'm')).toBe(92);
  });

  it('puede dar negativo si se egresa de mas (#5)', () => {
    const txs = [
      { medId: 'm', type: 'IN', amount: 3, createdAt: 1 },
      { medId: 'm', type: 'OUT', amount: 5, createdAt: 2 },
    ];
    expect(computeMedStock(txs, 'm')).toBe(-2);
  });
});

describe('formatCurrency / parseCurrency', () => {
  it('parseCurrency interpreta formato es-CR (miles con punto, decimal con coma)', () => {
    expect(parseCurrency('1.234,56')).toBeCloseTo(1234.56);
    expect(parseCurrency('')).toBe(0);
    expect(parseCurrency(null)).toBe(0);
  });

  it('formatCurrency devuelve cadena vacia para no numeros', () => {
    expect(formatCurrency('abc')).toBe('');
  });
});
