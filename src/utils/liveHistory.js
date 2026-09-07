// One server-backed subscription per medication and authenticated session.
// Dependencies are injected so synchronization and read volume can be tested.
export const createLiveHistory = ({ subscribe, onChange, onStatus, onMetrics, timeoutMs = 15000 }) => {
  const entries = new Map();
  let disposed = false;
  let online = true;
  const metrics = { subscriptions: 0, initialDocuments: 0, changedDocuments: 0, removedDocuments: 0, reuses: 0 };
  const report = () => onMetrics?.({ ...metrics });
  const fail = (medId, entry, error) => {
    if (disposed || entries.get(medId) !== entry) return;
    entry.error = error;
    entry.ready = false;
    entry.unsubscribe?.();
    entries.delete(medId);
    for (const waiter of entry.waiters) waiter.reject(error);
    entry.waiters.clear();
    onStatus?.(medId, 'error');
  };
  const ensure = (medId) => {
    if (entries.has(medId)) return entries.get(medId);
    const entry = { ready: false, items: [], waiters: new Set(), versions: null, unsubscribe: null };
    entries.set(medId, entry);
    metrics.subscriptions += 1;
    report();
    onStatus?.(medId, 'loading');
    const receive = (snapshot) => {
      if (disposed || entries.get(medId) !== entry) return;
      entry.ready = online && !snapshot.fromCache && !snapshot.hasPendingWrites;
      if (!entry.ready) {
        onStatus?.(medId, 'loading');
        return;
      }
      // Compare committed data, including acknowledgments after local writes.
      // These are observed documents, not a billing estimate (rules, reconnects,
      // other queries and other devices are not represented here).
      const versions = new Map(snapshot.items.map((item) => [String(item.id), JSON.stringify(item)]));
      if (entry.versions === null) metrics.initialDocuments += versions.size;
      else {
        for (const [id, version] of versions) {
          if (entry.versions.get(id) !== version) metrics.changedDocuments += 1;
        }
        for (const id of entry.versions.keys()) {
          if (!versions.has(id)) metrics.removedDocuments += 1;
        }
      }
      entry.versions = versions;
      entry.items = snapshot.items;
      onChange?.(medId, entry.items);
      onStatus?.(medId, 'complete');
      report();
      for (const waiter of entry.waiters) waiter.resolve(entry.items);
      entry.waiters.clear();
    };
    try {
      entry.unsubscribe = subscribe(medId, receive, (error) => fail(medId, entry, error));
    } catch (error) {
      fail(medId, entry, error);
      throw error;
    }
    if (entries.get(medId) !== entry) {
      entry.unsubscribe?.();
      throw entry.error;
    }
    return entry;
  };
  return {
    async read(medId) {
      if (disposed || !online) throw new Error('Historial sin conexion confirmada.');
      const entry = ensure(medId);
      if (entry.ready) {
        metrics.reuses += 1;
        report();
        return entry.items;
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (items) => { clearTimeout(timer); resolve(items); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        };
        const timer = setTimeout(() => {
          fail(medId, entry, new Error('No se pudo confirmar el historial con el servidor. Reintente.'));
        }, timeoutMs);
        entry.waiters.add(waiter);
      });
    },
    setOnline(value) {
      online = value;
      if (!value) {
        for (const [medId, entry] of entries) fail(medId, entry, new Error('Sin conexion.'));
      }
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        entry.unsubscribe?.();
        for (const waiter of entry.waiters) waiter.reject(new Error('Sesion finalizada.'));
      }
      entries.clear();
    },
  };
};

// Replace, do not union: a union resurrects remotely deleted transactions.
// The application's durable pending queue still takes precedence locally.
export const replaceMedicationHistory = (previous, medId, incoming, pending = []) => {
  const oldById = new Map(previous.map((item) => [String(item.id), item]));
  const byId = new Map(incoming.map((item) => [String(item.id), item]));
  for (const action of pending) {
    if (action.collection !== 'transactions') continue;
    const id = String(action.id);
    if (action.type === 'delete') byId.delete(id);
    else if (action.type === 'set') {
      const data = { ...(byId.get(id) || oldById.get(id)), ...action.data };
      if (data.medId === medId) byId.set(id, data);
      else byId.delete(id);
    }
  }
  return [...previous.filter((item) => item.medId !== medId && !byId.has(String(item.id))), ...byId.values()];
};
