import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInAnonymously } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, collection, query, where, onSnapshot,
  writeBatch, doc, setDoc, deleteDoc, terminate, disableNetwork, enableNetwork } from 'firebase/firestore';
import { createLiveHistory } from '../src/utils/liveHistory.js';

// Refuse to run unless launched by the local emulator command. Never production.
assert.equal(process.env.GCLOUD_PROJECT, 'demo-drogas-read-tests');
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):8088$/);
const apps = [1, 2].map((n) => initializeApp({ projectId: 'demo-drogas-read-tests', apiKey: 'demo-key' }, `client-${n}`));
const clients = apps.map((app) => {
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9098', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8088);
  return { auth, db };
});
let history;
try {
  await Promise.all(clients.map(({ auth }) => signInAnonymously(auth)));
  const [reader, writer] = clients.map(({ db }) => db);
  const path = `orgData/test-${Date.now()}/transactions`;
  for (let start = 0; start < 2000; start += 500) {
    const batch = writeBatch(writer);
    for (let n = start; n < start + 500; n++) {
      batch.set(doc(writer, path, `tx${n}`), { id: `tx${n}`, medId: 'm1', amount: 1, createdAt: n + 1 });
    }
    await batch.commit();
  }
  let lastItems = [];
  let lastStatus;
  let metrics;
  history = createLiveHistory({
    subscribe: (medId, next, error) => onSnapshot(
      query(collection(reader, path), where('medId', '==', medId)),
      { includeMetadataChanges: true },
      (snapshot) => next({ items: snapshot.docs.map((d) => d.data()),
        fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites }), error),
    onChange: (_, items) => { lastItems = items; },
    onStatus: (_, status) => { lastStatus = status; },
    onMetrics: (value) => { metrics = value; },
  });
  const waitUntil = async (condition) => {
    const deadline = Date.now() + 15000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'Timed out waiting for the real Firestore listener');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  assert.equal((await history.read('m1')).length, 2000);
  for (let n = 0; n < 100; n++) assert.equal((await history.read('m1')).length, 2000);
  assert.equal(metrics.subscriptions, 1);
  assert.equal(metrics.initialDocuments, 2000);
  assert.equal(metrics.reuses, 100);
  await setDoc(doc(writer, path, 'tx0'), { amount: 7 }, { merge: true });
  await waitUntil(() => lastItems.find((item) => item.id === 'tx0')?.amount === 7);
  assert.equal((await history.read('m1')).find((item) => item.id === 'tx0').amount, 7);
  await deleteDoc(doc(writer, path, 'tx0'));
  await waitUntil(() => lastItems.length === 1999);
  assert.equal((await history.read('m1')).some((item) => item.id === 'tx0'), false);
  await setDoc(doc(writer, path, 'new'), { id: 'new', medId: 'm1', amount: 4 });
  await waitUntil(() => lastItems.length === 2000);
  assert.equal((await history.read('m1')).some((item) => item.id === 'new'), true);
  assert.equal(metrics.subscriptions, 1);
  assert.equal(metrics.changedDocuments, 2);
  assert.equal(metrics.removedDocuments, 1);
  await disableNetwork(reader);
  await waitUntil(() => lastStatus === 'loading');
  let resolved = false;
  const pending = history.read('m1').then((items) => { resolved = true; return items; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resolved, false, 'Cache-only data must not authorize verification');
  await enableNetwork(reader);
  assert.equal((await pending).length, 2000);
  console.log('PASS: two authenticated clients, 2000 initial documents, 100 reuses, remote edit/delete/create, offline cache blocked, reconnect confirmed.');
  console.log(JSON.stringify(metrics));
} finally {
  history?.dispose();
  await Promise.all(clients.map(({ db }) => terminate(db)));
  await Promise.all(apps.map((app) => deleteApp(app)));
}
