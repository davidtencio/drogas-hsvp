import { describe, expect, it } from 'vitest';
import { getBackupChecksumSource, getBackupSummary } from './backup';

describe('backup helpers', () => {
  it('counts every collection included in a backup', () => {
    expect(getBackupSummary({
      medications: [{}, {}], transactions: [{}, {}, {}], expedientes: [{}], bitacora: [],
      services: [{}, {}], pharmacists: [{}], condiciones: [{}, {}, {}, {}],
    })).toEqual({
      medications: 2, transactions: 3, expedientes: 1, bitacora: 0,
      services: 2, pharmacists: 1, condiciones: 4,
    });
  });

  it('uses empty arrays when optional backup data is absent', () => {
    expect(getBackupSummary()).toEqual({
      medications: 0, transactions: 0, expedientes: 0, bitacora: 0,
      services: 0, pharmacists: 0, condiciones: 0,
    });
  });

  it('preserves the checksum source format used by schema version 2', () => {
    const summary = getBackupSummary({ transactions: [{}, {}], services: [{}] });
    expect(getBackupChecksumSource(summary, 'fent-50', 40000)).toBe('0|2|0|0|1|0|0|fent-50|40000');
  });
});
