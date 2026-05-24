import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, getDocs, getFirestore, query, where, writeBatch } from 'firebase/firestore';

const ORG_ID = 'hsvp';
const DATA_DOC_PATH = `orgData/${ORG_ID}`;

const requiredEnv = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
  'FIREBASE_EMAIL',
  'FIREBASE_PASSWORD',
];

const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('Faltan variables de entorno:', missing.join(', '));
  process.exit(1);
}

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    apply: false,
    medName: 'FENTANYL 50 MCG',
    keep: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--med-name') {
      options.medName = (args[i + 1] || '').toUpperCase();
      i += 1;
      continue;
    }
    if (arg === '--keep') {
      options.keep.push((args[i + 1] || '').toUpperCase());
      i += 1;
      continue;
    }
  }

  return options;
};

const normalize = (value) => (value ? String(value).toUpperCase().trim() : '');

const txSignature = (tx) => {
  const prescription = normalize(tx.prescription);
  const amount = Number(tx.amount) || 0;
  const date = normalize(tx.date);
  return `${prescription}|${amount}|${date}`;
};

const main = async () => {
  const opts = parseArgs();
  if (opts.keep.length === 0) {
    console.error('Debes pasar al menos un --keep "RECETA|CANTIDAD|FECHA".');
    process.exit(1);
  }

  const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.VITE_FIREBASE_APP_ID,
  };

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  await signInWithEmailAndPassword(auth, process.env.FIREBASE_EMAIL, process.env.FIREBASE_PASSWORD);

  const orgDoc = await getDoc(doc(db, DATA_DOC_PATH));
  if (!orgDoc.exists()) {
    throw new Error(`No existe ${DATA_DOC_PATH}`);
  }

  const medications = orgDoc.data().medications || [];
  const med = medications.find((m) => normalize(m.name) === normalize(opts.medName));
  if (!med) {
    throw new Error(`No se encontro medicamento con nombre exacto: ${opts.medName}`);
  }

  const medId = med.id;
  const txRef = collection(db, DATA_DOC_PATH, 'transactions');
  const txSnap = await getDocs(query(txRef, where('medId', '==', medId)));
  const txs = txSnap.docs.map((d) => ({ ...d.data(), _docId: d.id }));

  const closeAnchors = txs
    .filter(
      (t) =>
        t.isCierre &&
        (normalize(t.cierreTurno) === 'CIERRE 24 HORAS' || normalize(t.cierreTurno) === 'AJUSTE MANUAL SALDO'),
    )
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

  const latestAnchor = closeAnchors[0];
  if (!latestAnchor) {
    throw new Error('No se encontro cierre ancla (CIERRE 24 HORAS / AJUSTE MANUAL SALDO).');
  }

  const anchorTime = Number(latestAnchor.createdAt) || 0;
  const keepSet = new Set(opts.keep.map((x) => normalize(x)));

  const candidates = txs
    .filter((t) => !t.isCierre)
    .filter((t) => (Number(t.createdAt) || 0) > anchorTime)
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

  const toKeep = [];
  const toDelete = [];
  for (const tx of candidates) {
    const sig = txSignature(tx);
    if (keepSet.has(sig)) toKeep.push({ ...tx, _sig: sig });
    else toDelete.push({ ...tx, _sig: sig });
  }

  const missingKeep = [...keepSet].filter((wanted) => !toKeep.some((tx) => tx._sig === wanted));

  console.log('--- RESUMEN ---');
  console.log('Medicamento:', med.name, `(${medId})`);
  console.log('Cierre ancla:', latestAnchor.date, '|', latestAnchor.cierreTurno, '| stock:', latestAnchor.totalMedicamento);
  console.log('Movimientos post-cierre evaluados:', candidates.length);
  console.log('Se conservarian:', toKeep.length);
  console.log('Se eliminarian:', toDelete.length);
  if (missingKeep.length > 0) {
    console.log('Firmas --keep no encontradas:');
    missingKeep.forEach((k) => console.log('  -', k));
  }

  if (toDelete.length > 0) {
    console.log('\nPrimeros 20 a eliminar:');
    toDelete.slice(0, 20).forEach((tx) => {
      console.log(`  - ${tx._docId} | ${tx.date} | ${tx.prescription} | ${tx.amount} | ${tx.type}`);
    });
  }

  if (!opts.apply) {
    console.log('\nModo DRY-RUN (sin cambios). Usa --apply para ejecutar borrado real.');
    return;
  }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 450) {
    const chunk = toDelete.slice(i, i + 450);
    const batch = writeBatch(db);
    chunk.forEach((tx) => {
      batch.delete(doc(db, DATA_DOC_PATH, 'transactions', tx._docId));
    });
    await batch.commit();
    deleted += chunk.length;
  }

  console.log(`\nBorrado completado. Registros eliminados: ${deleted}`);
};

main().catch((error) => {
  console.error('Error:', error.message || error);
  process.exit(1);
});
