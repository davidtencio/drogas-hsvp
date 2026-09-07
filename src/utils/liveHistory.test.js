import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveHistory, replaceMedicationHistory } from './liveHistory';
import { allocateLotsFEFO } from './lots';

const harness = (options = {}) => {
  const streams = new Map();
  const onChange = vi.fn();
  const onMetrics = vi.fn();
  const subscribe = vi.fn((medId, next, error) => {
    const unsubscribe = vi.fn();
    streams.set(medId, { next, error, unsubscribe });
    return unsubscribe;
  });
  const history = createLiveHistory({ subscribe, onChange, onMetrics, ...options });
  const emit = (items, metadata = {}, medId = 'm1') => streams.get(medId).next({
    items, fromCache: false, hasPendingWrites: false, ...metadata,
  });
  return { history, emit, streams, subscribe, onChange, onMetrics };
};
afterEach(() => vi.useRealTimers());

describe('live medication history', () => {
  it('rejects synchronous subscription failures instead of retaining a broken entry', async () => {
    const history = createLiveHistory({ subscribe: () => { throw new Error('Invalid query'); } });
    await expect(history.read('m1')).rejects.toThrow('Invalid query');
    await expect(history.read('m1')).rejects.toThrow('Invalid query');
    history.dispose();
  });

  it('shares a first load and reuses 2,000 documents for 100 verifications', async () => {
    const h = harness();
    const first = h.history.read('m1');
    const concurrent = h.history.read('m1');
    const items = Array.from({ length: 2000 }, (_, id) => ({ id, medId: 'm1', amount: 1 }));
    h.emit(items);
    expect(await first).toEqual(items);
    expect(await concurrent).toEqual(items);
    for (let n = 0; n < 100; n++) expect(await h.history.read('m1')).toEqual(items);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.onMetrics).toHaveBeenLastCalledWith({
      subscriptions: 1, initialDocuments: 2000, changedDocuments: 0, removedDocuments: 0, reuses: 100,
    });
    h.history.dispose();
  });

  it('uses remote additions, modifications and deletions in the next FEFO calculation', async () => {
    const h = harness();
    const first = h.history.read('m1');
    const origin = { id: 'in', medId: 'm1', type: 'IN', amount: 10, lotNumber: 'A', expirationDate: '2099-01-01', createdAt: 1 };
    const out = { id: 'out', medId: 'm1', type: 'OUT', amount: 4, createdAt: 2,
      lotAllocations: [{ sourceTransactionId: 'in', lotNumber: 'A', expirationDate: '2099-01-01', quantity: 4 }] };
    h.emit([origin]);
    expect(allocateLotsFEFO(await first, 'm1', 7).ok).toBe(true);
    h.emit([origin, out]);
    expect(allocateLotsFEFO(await h.history.read('m1'), 'm1', 7).ok).toBe(false);
    h.emit([{ ...origin, amount: 12 }, out]);
    expect(allocateLotsFEFO(await h.history.read('m1'), 'm1', 7).ok).toBe(true);
    h.emit([out]);
    expect(allocateLotsFEFO(await h.history.read('m1'), 'm1', 1).ok).toBe(false);
    expect(h.onMetrics).toHaveBeenLastCalledWith({
      subscriptions: 1, initialDocuments: 1, changedDocuments: 2, removedDocuments: 1, reuses: 3,
    });
    h.history.dispose();
  });

  it('waits for server metadata, including a pending write acknowledgment', async () => {
    const h = harness();
    const done = vi.fn();
    const pending = h.history.read('m1').then(done);
    h.emit([{ id: 1 }], { fromCache: true });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    h.emit([{ id: 1 }], { hasPendingWrites: true });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    h.emit([{ id: 1 }]);
    await pending;
    expect(done).toHaveBeenCalledWith([{ id: 1 }]);
    // A cache event after a server snapshot invalidates readiness as well.
    h.emit([{ id: 1 }], { fromCache: true });
    const nextDone = vi.fn();
    const next = h.history.read('m1').then(nextDone);
    await Promise.resolve();
    expect(nextDone).not.toHaveBeenCalled();
    h.emit([{ id: 2 }]);
    await next;
    expect(nextDone).toHaveBeenCalledWith([{ id: 2 }]);
    h.history.dispose();
  });

  it('fails closed on timeout and permits an explicit retry', async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 50 });
    const pending = h.history.read('m1');
    const assertion = expect(pending).rejects.toThrow('confirmar');
    h.emit([], { fromCache: true });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(h.streams.get('m1').unsubscribe).toHaveBeenCalledTimes(1);
    const retry = h.history.read('m1');
    h.emit([]);
    expect(await retry).toEqual([]);
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    h.history.dispose();
  });

  it('invalidates offline data and reconnects with a new server-confirmed snapshot', async () => {
    const h = harness();
    const first = h.history.read('m1');
    h.emit([{ id: 1 }]);
    await first;
    const oldStream = h.streams.get('m1');
    h.history.setOnline(false);
    expect(oldStream.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(h.history.read('m1')).rejects.toThrow('conexion');
    h.history.setOnline(true);
    const retry = h.history.read('m1');
    oldStream.next({ items: [{ id: 'stale' }], fromCache: false });
    h.emit([{ id: 2 }]);
    expect(await retry).toEqual([{ id: 2 }]);
    h.history.dispose();
  });

  it('rejects listeners on errors and closes all medications at logout', async () => {
    const h = harness();
    const bad = h.history.read('m1');
    h.streams.get('m1').error(new Error('permission-denied'));
    await expect(bad).rejects.toThrow('permission-denied');
    const pending = h.history.read('m2');
    const next = h.streams.get('m2').next;
    h.history.dispose();
    await expect(pending).rejects.toThrow('Sesion');
    next({ items: [], fromCache: false });
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.streams.get('m2').unsubscribe).toHaveBeenCalledTimes(1);
    await expect(h.history.read('m2')).rejects.toThrow();
  });
});

describe('authoritative medication replacement', () => {
  it('removes stale deleted records and preserves other medications', () => {
    const other = { id: 'other', medId: 'm2' };
    expect(replaceMedicationHistory([{ id: 'deleted', medId: 'm1' }, other], 'm1', [])).toEqual([other]);
  });
  it('preserves queued creations, edits and deletions until acknowledged', () => {
    expect(replaceMedicationHistory([], 'm1', [{ id: 1, medId: 'm1', amount: 3 }, { id: 2, medId: 'm1' }], [
      { collection: 'transactions', type: 'set', id: 1, data: { id: 1, medId: 'm1', amount: 2 } },
      { collection: 'transactions', type: 'delete', id: 2 },
      { collection: 'transactions', type: 'set', id: 3, data: { id: 3, medId: 'm1', amount: 1 } },
      { collection: 'expedientes', type: 'delete', id: 1 },
    ])).toEqual([{ id: 1, medId: 'm1', amount: 2 }, { id: 3, medId: 'm1', amount: 1 }]);
  });
});
