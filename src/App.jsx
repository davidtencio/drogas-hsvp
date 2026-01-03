import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  Filter,
  History,
  Package,
  PlusCircle,
  ShieldCheck,
} from 'lucide-react';
import { auth, db, googleProvider } from './firebase';
import { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter, writeBatch, deleteField } from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';

// --- CONFIGURACION ---
const INITIAL_MEDICATIONS = [
  { id: 'morf-15', name: 'MORFINA 15 MG', type: 'Estupefaciente', unitPrice: 0, quota: 0 },
  { id: 'fent-50', name: 'FENTANYL 50 MCG', type: 'Estupefaciente', unitPrice: 0, quota: 0 },
  { id: 'diaz-10', name: 'DIAZEPAM 10 MG', type: 'Psicotropico', unitPrice: 0, quota: 0 },
  { id: 'midaz-15', name: 'MIDAZOLAM 15 MG', type: 'Psicotropico', unitPrice: 0, quota: 0 },
  { id: 'clon-2', name: 'CLONAZEPAM 2 MG', type: 'Psicotropico', unitPrice: 0, quota: 0 },
  { id: 'feno-50', name: 'FENOBARBITAL 50 MG', type: 'Psicotropico', unitPrice: 0, quota: 0 },
];

const INITIAL_SERVICES = ['EMERGENCIAS', 'MEDICINA', 'CIRUGIA', 'PEDIATRIA', 'UCI', 'CLINICA DEL DOLOR'];
const INITIAL_PHARMACISTS = ['2492 ESTHER HERNANDEZ', '2488 VIVIANA ESQUIVEL', '3632 GINNETTE MONTERO', '4511 JEANNETTE SALAZAR'];
const INITIAL_CONDICIONES = ['VALIDACION', 'INCONSISTENTE', 'SUSPENDIDA', 'EGRESO'];
const MED_TYPES = ['Estupefaciente', 'Psicotropico', 'Otros'];

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [medications, setMedications] = useState(INITIAL_MEDICATIONS);
  const [selectedMedId, setSelectedMedId] = useState(INITIAL_MEDICATIONS[0].id);
  const [editingMedId, setEditingMedId] = useState(null);
  const [editingTransactionId, setEditingTransactionId] = useState(null);
  const [editingExpedienteId, setEditingExpedienteId] = useState(null);
  const [prefillKardexType, setPrefillKardexType] = useState('');
  const [isQuickIngreso, setIsQuickIngreso] = useState(false);
  const [showCatalogMenu, setShowCatalogMenu] = useState(false);
  const [services, setServices] = useState(INITIAL_SERVICES);
  const [pharmacists, setPharmacists] = useState(INITIAL_PHARMACISTS);
  const [rxTypeValue, setRxTypeValue] = useState('CERRADA');
  const [cloudStatus, setCloudStatus] = useState('Sincronizando...');
  const [condiciones, setCondiciones] = useState(INITIAL_CONDICIONES);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncErrors, setSyncErrors] = useState([]);
  const pendingWritesRef = useRef([]);
  const isFlushingRef = useRef(false);
  const retryTimeoutRef = useRef(null);
  const retryCountRef = useRef(0);
  const createdAtBackfillRef = useRef({});

  const toUpper = (value) => (value ? value.toString().toUpperCase().trim() : '');
  const formatCurrency = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const parseCurrency = (value) => {
    if (value === null || value === undefined) return 0;
    const cleaned = value.toString().replace(/\s/g, '');
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(normalized);
    return Number.isFinite(num) ? num : 0;
  };
  const nextOpenRxUse = (items, medId, prescription, rxQuantity) => {
    const matches = items.filter(
      (t) => t.medId === medId && t.rxType === 'ABIERTA' && t.prescription === prescription && t.rxQuantity === rxQuantity,
    );
    if (matches.length === 0) return 1;
    const maxUsed = Math.max(...matches.map((t) => t.rxUsed || 0));
    return Math.min(maxUsed + 1, rxQuantity);
  };

  const parseDateTime = (value) => {
    if (!value) return null;
    const cleaned = value.replace(',', '');
    const [datePart, timePart] = cleaned.split(' ');
    if (!datePart) return null;
    const [day, month, year] = datePart.split('/').map(Number);
    if (!day || !month || !year) return null;
    const [hour = 0, minute = 0] = (timePart || '').split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute);
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const handleOpenRxUse = (transaction) => {
    if (transaction.rxType !== 'ABIERTA' || transaction.rxQuantity <= 0) return;
    const nextUsed = nextOpenRxUse(transactions, transaction.medId, transaction.prescription, transaction.rxQuantity);
    if (nextUsed <= transaction.rxUsed) return;
    const now = new Date().toLocaleString('es-CR', { hour12: false }).slice(0, 16);
    const newTransaction = {
      ...transaction,
      id: Date.now(),
      date: now,
      type: 'OUT',
      rxUsed: nextUsed,
    };
    setTransactions([newTransaction, ...transactions]);
    enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
  };

  const enqueueWrite = (action) => {
    const next = [...(pendingWritesRef.current || []), action];
    pendingWritesRef.current = next;
    localStorage.setItem('pharmaPendingWrites', JSON.stringify(next));
    setPendingCount(next.length);
    if (!authUser) return;
    flushWriteQueue();
  };

  const flushWriteQueue = async () => {
    if (isFlushingRef.current || !authUser) return;
    const queue = pendingWritesRef.current || [];
    if (queue.length === 0) return;
    isFlushingRef.current = true;
    setCloudStatus('Sincronizando...');
    try {
      const remaining = [];
      const errors = [];
      for (const action of queue) {
        try {
          if (action.type === 'set') {
            await setDoc(doc(db, 'appState', authUser.uid, action.collection, String(action.id)), action.data, { merge: true });
          } else if (action.type === 'delete') {
            await deleteDoc(doc(db, 'appState', authUser.uid, action.collection, String(action.id)));
          }
        } catch {
          remaining.push(action);
          errors.push({
            id: action.id,
            collection: action.collection,
            type: action.type,
            time: new Date().toLocaleString('es-CR', { hour12: false }).slice(0, 16),
          });
        }
      }
      pendingWritesRef.current = remaining;
      localStorage.setItem('pharmaPendingWrites', JSON.stringify(remaining));
      setPendingCount(remaining.length);
      if (remaining.length === 0) {
        localStorage.removeItem('pharmaPendingWrites');
        setCloudStatus('Sincronizado');
        setSyncError('');
        retryCountRef.current = 0;
        setSyncErrors([]);
      } else {
        setCloudStatus('Sin conexion');
        setSyncError('Algunos registros no pudieron sincronizarse.');
        setSyncErrors((prev) => [...errors, ...prev].slice(0, 50));
        if (!retryTimeoutRef.current) {
          const delayMs = Math.min(30000, 2000 * Math.pow(2, retryCountRef.current));
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            retryCountRef.current += 1;
            flushWriteQueue();
          }, delayMs);
        }
      }
    } catch {
      setCloudStatus('Sin conexion');
    } finally {
      isFlushingRef.current = false;
    }
  };

  const handleAuth = async (mode) => {
    setAuthError('');
    try {
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      } else {
        await createUserWithEmailAndPassword(auth, authEmail, authPassword);
      }
    } catch {
      setAuthError('Credenciales invalidas o usuario existente.');
    }
  };

  const handleGoogleAuth = async () => {
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch {
      setAuthError('No se pudo iniciar con Google.');
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      setAuthLoading(false);
      setCloudStatus(user ? 'Sincronizado' : 'Sin sesion');
      if (!user) {
        setCloudReady(false);
        setTransactions([]);
        setExpedientes([]);
        setBitacora([]);
        setMedications(INITIAL_MEDICATIONS);
        setServices(INITIAL_SERVICES);
        setPharmacists(INITIAL_PHARMACISTS);
        setCondiciones(INITIAL_CONDICIONES);
        setSelectedMedId(INITIAL_MEDICATIONS[0].id);
        setPendingCount(0);
        setSyncErrors([]);
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('pharmaPendingWrites') || '[]');
      if (Array.isArray(stored)) {
        pendingWritesRef.current = stored;
        setPendingCount(stored.length);
      }
    } catch {
      pendingWritesRef.current = [];
      localStorage.removeItem('pharmaPendingWrites');
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    if (pendingWritesRef.current.length > 0) {
      flushWriteQueue();
    }
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const hydrateFromCloud = async () => {
      setCloudLoading(true);
      setCloudStatus('Sincronizando...');
      try {
        const ref = doc(db, 'appState', authUser.uid);
        const snap = await getDoc(ref);
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          if (data.medications?.length) setMedications(data.medications);
          if (data.services?.length) setServices(data.services);
          if (data.pharmacists?.length) setPharmacists(data.pharmacists);
          if (data.condiciones?.length) setCondiciones(data.condiciones);
          if (data.selectedMedId) setSelectedMedId(data.selectedMedId);
          if (data.transactions?.length || data.expedientes?.length || data.bitacora?.length) {
            const batch = writeBatch(db);
            data.transactions?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.date)?.getTime() ?? Date.now();
              batch.set(doc(db, 'appState', authUser.uid, 'transactions', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            data.expedientes?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.fecha)?.getTime() ?? Date.now();
              batch.set(doc(db, 'appState', authUser.uid, 'expedientes', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            data.bitacora?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.fecha)?.getTime() ?? Date.now();
              batch.set(doc(db, 'appState', authUser.uid, 'bitacora', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            await batch.commit();
            await setDoc(
              ref,
              { transactions: deleteField(), expedientes: deleteField(), bitacora: deleteField() },
              { merge: true },
            );
          }
        }

        const loadCollection = async (name, setter, dateField) => {
          const colRef = collection(db, 'appState', authUser.uid, name);
          if (!createdAtBackfillRef.current[name]) {
            createdAtBackfillRef.current[name] = true;
            const backfillQuery = query(colRef, orderBy('__name__'), limit(8000));
            const backfillSnap = await getDocs(backfillQuery);
            let batch = writeBatch(db);
            let batchCount = 0;
            backfillSnap.docs.forEach((docSnap) => {
              const data = docSnap.data();
              if (data.createdAt || data.updatedAt) return;
              const source = data[dateField];
              const createdAt = parseDateTime(source)?.getTime() ?? Date.now();
              batch.set(docSnap.ref, { createdAt, updatedAt: Date.now() }, { merge: true });
              batchCount += 1;
              if (batchCount >= 450) {
                batch.commit();
                batch = writeBatch(db);
                batchCount = 0;
              }
            });
            if (batchCount > 0) {
              await batch.commit();
            }
          }
          const items = [];
          let lastDoc = null;
          while (items.length < 8000) {
            try {
              const q = lastDoc
                ? query(colRef, orderBy('createdAt', 'desc'), startAfter(lastDoc), limit(500))
                : query(colRef, orderBy('createdAt', 'desc'), limit(500));
              const snap = await getDocs(q);
              if (snap.empty) break;
              items.push(...snap.docs.map((d) => d.data()));
              lastDoc = snap.docs[snap.docs.length - 1];
              if (snap.docs.length < 500) break;
              await delay(50);
            } catch {
              const fallbackQuery = lastDoc
                ? query(colRef, orderBy('__name__'), startAfter(lastDoc), limit(500))
                : query(colRef, orderBy('__name__'), limit(500));
              const snap = await getDocs(fallbackQuery);
              if (snap.empty) break;
              items.push(...snap.docs.map((d) => d.data()));
              lastDoc = snap.docs[snap.docs.length - 1];
              if (snap.docs.length < 500) break;
              await delay(50);
            }
          }
          setter(items.slice(0, 8000));
          return items;
        };
        const [transactionsLoaded, expedientesLoaded, bitacoraLoaded] = await Promise.all([
          loadCollection('transactions', setTransactions, 'date'),
          loadCollection('expedientes', setExpedientes, 'fecha'),
          loadCollection('bitacora', setBitacora, 'fecha'),
        ]);
        if (!transactionsLoaded || !expedientesLoaded || !bitacoraLoaded) {
          setCloudStatus('Sin conexion');
        }
      } catch {
        try {
          const stored = JSON.parse(localStorage.getItem('pharmaControlData') || '{}');
          if (stored.transactions?.length) setTransactions(stored.transactions);
          if (stored.expedientes?.length) setExpedientes(stored.expedientes);
          if (stored.medications?.length) setMedications(stored.medications);
          if (stored.services?.length) setServices(stored.services);
          if (stored.pharmacists?.length) setPharmacists(stored.pharmacists);
          if (stored.condiciones?.length) setCondiciones(stored.condiciones);
          if (stored.selectedMedId) setSelectedMedId(stored.selectedMedId);
          if (stored.bitacora?.length) setBitacora(stored.bitacora);
        } catch {
          localStorage.removeItem('pharmaControlData');
        }
      } finally {
        if (!cancelled) {
          setCloudReady(true);
          if (syncError) setCloudStatus('Sin conexion');
          else setCloudStatus('Sincronizado');
          setCloudLoading(false);
        }
      }
    };
    hydrateFromCloud();
    return () => {
      cancelled = true;
    };
  }, [authUser]);

  // Data States
  const [transactions, setTransactions] = useState([
    {
      id: 1,
      date: '27/08/2025 13:34',
      medId: 'morf-15',
      type: 'IN',
      amount: 184,
      service: 'INGRESO A INVENTARIO',
      pharmacist: '2492 ESTHER HERNANDEZ',
      prescription: '',
      cama: '',
      rxType: 'CERRADA',
      rxQuantity: 0,
      rxUsed: 0,
    },
  ]);
  const [expedientes, setExpedientes] = useState([
    {
      id: 1,
      fecha: '27/08/2025 21:27',
      servicio: 'EMERGENCIAS',
      cedula: '107910955',
      receta: '9851303L',
      medicamento: 'DIAZEPAM 10 MG',
      dosis: '1 AMP STAT',
      condicion: 'VALIDACION',
      farmaceutico: '2488 VIVIANA ESQUIVEL',
    },
  ]);
  const [bitacora, setBitacora] = useState([]);

  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [cloudReady, setCloudReady] = useState(false);

  useEffect(() => {
    const localPayload = {
      transactions,
      expedientes,
      bitacora,
      medications,
      services,
      pharmacists,
      condiciones,
      selectedMedId,
    };
    localStorage.setItem('pharmaControlData', JSON.stringify(localPayload));
    if (!cloudReady || !authUser) return;
    const cloudPayload = {
      medications,
      services,
      pharmacists,
      condiciones,
      selectedMedId,
    };
    setCloudStatus('Sincronizando...');
    setDoc(doc(db, 'appState', authUser.uid), cloudPayload, { merge: true })
      .then(() => setCloudStatus('Sincronizado'))
      .catch(() => setCloudStatus('Sin conexion'));
  }, [transactions, expedientes, bitacora, medications, services, pharmacists, condiciones, selectedMedId]);

  // Computations
  const sortedMedications = useMemo(() => {
    return [...medications].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }, [medications]);

  const currentInventory = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    return sortedMedications.map((med) => {
      const medTransactions = transactions.filter((t) => t.medId === med.id && !t.isCierre);
      const stock = medTransactions.reduce((acc, t) => (t.type === 'IN' ? acc + t.amount : acc - t.amount), 0);
      const weeklyOut = medTransactions.reduce((acc, t) => {
        if (t.type !== 'OUT') return acc;
        const when = t.createdAt ? new Date(t.createdAt) : parseDateTime(t.date);
        if (!when || when < cutoff) return acc;
        return acc + t.amount;
      }, 0);
      const minRecommended = weeklyOut;
      return { ...med, stock, weeklyOut, minRecommended };
    });
  }, [transactions, sortedMedications]);

  const stats = useMemo(
    () => ({
      totalStock: currentInventory.reduce((acc, curr) => acc + curr.stock, 0),
      lowStock: currentInventory.filter((m) => m.stock < 15).length,
      todayReviews: expedientes.length,
    }),
    [currentInventory, expedientes],
  );

  const { recentTransactions, historicTransactions } = useMemo(() => {
    const medTransactions = transactions.filter((t) => t.medId === selectedMedId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const recent = [];
    const historic = [];
    medTransactions.forEach((t) => {
      const when = t.createdAt ? new Date(t.createdAt) : parseDateTime(t.date);
      if (when && when >= cutoff) {
        recent.push(t);
      } else {
        historic.push(t);
      }
    });
    return { recentTransactions: recent, historicTransactions: historic };
  }, [transactions, selectedMedId]);

  const handleSave = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const now = new Date().toLocaleString('es-CR', { hour12: false }).slice(0, 16);

    if (modalType === 'kardex') {
      const rxType = isQuickIngreso ? 'CERRADA' : formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const medId = formData.get('medicationId');
      const prescription = isQuickIngreso ? '' : toUpper(formData.get('prescription'));
      const rxUsed =
        rxType === 'ABIERTA' && rxQuantity > 0 ? nextOpenRxUse(transactions, medId, prescription, rxQuantity) : 0;
      const newTransaction = {
        id: Date.now(),
        date: now,
        createdAt: Date.now(),
        medId,
        type: isQuickIngreso ? 'IN' : 'OUT',
        amount: parseInt(formData.get('amount'), 10),
        service: isQuickIngreso ? 'INGRESO A INVENTARIO' : toUpper(formData.get('service')),
        cama: isQuickIngreso ? '' : toUpper(formData.get('cama')),
        prescription,
        rxType,
        rxQuantity,
        rxUsed,
        pharmacist: isQuickIngreso ? toUpper(pharmacists[0] || '') : toUpper(formData.get('pharmacist')),
      };
      setTransactions([newTransaction, ...transactions]);
      enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
    } else if (modalType === 'kardex-edit') {
      const current = transactions.find((t) => t.id === editingTransactionId);
      const rxType = formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const rxUsed = rxType === 'ABIERTA' ? Math.min(current?.rxUsed ?? 0, rxQuantity) : 0;
      const updated = {
        id: editingTransactionId,
        date: now,
        createdAt: current?.createdAt ?? parseDateTime(current?.date || now)?.getTime() ?? Date.now(),
        medId: formData.get('medicationId'),
        type: current?.type === 'IN' ? 'IN' : 'OUT',
        amount: parseInt(formData.get('amount'), 10),
        service: toUpper(formData.get('service')),
        cama: toUpper(formData.get('cama')),
        prescription: toUpper(formData.get('prescription')),
        rxType,
        rxQuantity,
        rxUsed,
        pharmacist: toUpper(formData.get('pharmacist')),
      };
      setTransactions(transactions.map((t) => (t.id === editingTransactionId ? updated : t)));
      enqueueWrite({ type: 'set', collection: 'transactions', id: updated.id, data: updated });
    } else if (modalType === 'auditoria') {
      const newExp = {
        id: Date.now(),
        fecha: now,
        createdAt: Date.now(),
        servicio: toUpper(formData.get('servicio')),
        cedula: toUpper(formData.get('cedula')),
        receta: toUpper(formData.get('receta')),
        medicamento: toUpper(formData.get('medicamento')),
        dosis: toUpper(formData.get('dosis')),
        condicion: toUpper(formData.get('condicion')),
        farmaceutico: toUpper(formData.get('farmaceutico')),
      };
      setExpedientes([newExp, ...expedientes]);
      enqueueWrite({ type: 'set', collection: 'expedientes', id: newExp.id, data: newExp });
    } else if (modalType === 'auditoria-edit') {
      const current = expedientes.find((e) => e.id === editingExpedienteId);
      const updated = {
        id: editingExpedienteId,
        fecha: current?.fecha || now,
        createdAt: current?.createdAt ?? parseDateTime(current?.fecha || now)?.getTime() ?? Date.now(),
        servicio: toUpper(formData.get('servicio')),
        cedula: toUpper(formData.get('cedula')),
        receta: toUpper(formData.get('receta')),
        medicamento: toUpper(formData.get('medicamento')),
        dosis: toUpper(formData.get('dosis')),
        condicion: toUpper(formData.get('condicion')),
        farmaceutico: toUpper(formData.get('farmaceutico')),
      };
      setExpedientes(expedientes.map((e) => (e.id === editingExpedienteId ? updated : e)));
      enqueueWrite({ type: 'set', collection: 'expedientes', id: updated.id, data: updated });
    } else if (modalType === 'cierre') {
      const cierreTurno = toUpper(formData.get('turno'));
      const newCierre = {
        id: Date.now(),
        date: now,
        createdAt: Date.now(),
        medId: selectedMedId,
        type: 'IN',
        amount: 0,
        service: 'CIERRE DE INVENTARIO',
        cama: '',
        prescription: '',
        rxType: 'CERRADA',
        rxQuantity: 0,
        rxUsed: 0,
        pharmacist: toUpper(formData.get('farmaceutico')),
        isCierre: true,
        cierreTurno,
        totalRecetas: parseInt(formData.get('totalRecetas'), 10) || 0,
        totalMedicamento: parseInt(formData.get('totalMedicamento'), 10) || 0,
      };
      setTransactions([newCierre, ...transactions]);
      enqueueWrite({ type: 'set', collection: 'transactions', id: newCierre.id, data: newCierre });
    } else if (modalType === 'bitacora') {
      const newEntry = {
        id: Date.now(),
        fecha: now,
        createdAt: Date.now(),
        servicio: toUpper(formData.get('servicio')),
        titulo: toUpper(formData.get('titulo')),
        detalle: toUpper(formData.get('detalle')),
        responsable: toUpper(formData.get('responsable')),
      };
      setBitacora([newEntry, ...bitacora]);
      enqueueWrite({ type: 'set', collection: 'bitacora', id: newEntry.id, data: newEntry });
    } else if (modalType === 'med-add') {
      const newId = `med-${Date.now()}`;
      const newMed = {
        id: newId,
        name: toUpper(formData.get('medName')),
        type: formData.get('medType'),
        unitPrice: parseCurrency(formData.get('unitPrice')),
        quota: parseInt(formData.get('quota'), 10) || 0,
      };
      setMedications([newMed, ...medications]);
      setSelectedMedId(newId);
    } else if (modalType === 'med-edit') {
      const updated = {
        id: editingMedId,
        name: toUpper(formData.get('medName')),
        type: formData.get('medType'),
        unitPrice: parseCurrency(formData.get('unitPrice')),
        quota: parseInt(formData.get('quota'), 10) || 0,
      };
      setMedications(medications.map((m) => (m.id === editingMedId ? updated : m)));
    } else if (modalType === 'service-add') {
      const newService = toUpper(formData.get('serviceName'));
      setServices([newService, ...services]);
    } else if (modalType === 'pharmacist-add') {
      const newPharmacist = toUpper(formData.get('pharmacistName'));
      setPharmacists([newPharmacist, ...pharmacists]);
    } else if (modalType === 'condition-add') {
      const newCondition = toUpper(formData.get('conditionName'));
      setCondiciones([newCondition, ...condiciones]);
    }
    setShowModal(false);
    setEditingMedId(null);
    setEditingTransactionId(null);
    setEditingExpedienteId(null);
    setRxTypeValue('CERRADA');
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row font-sans text-slate-900 overflow-hidden">
      {/* Sidebar - Clean & Professional */}
      <nav className="w-full md:w-64 bg-slate-900 border-r border-slate-800 shrink-0 flex flex-col z-20">
        <div className="p-8">
          <div className="flex items-center gap-3 text-white mb-2">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Database size={20} />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Control de Drogas Hospitalizados</h1>
          </div>
          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest border-l border-blue-600 pl-2">Servicio de Farmacia</p>
        </div>

        <div className="flex-1 px-4 space-y-1">
          <NavItem active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Activity size={18} />} label="Dashboard" />
          <NavItem active={activeTab === 'kardex'} onClick={() => setActiveTab('kardex')} icon={<History size={18} />} label="Kardex Individual" />
          <NavItem active={activeTab === 'auditoria'} onClick={() => setActiveTab('auditoria')} icon={<ShieldCheck size={18} />} label="Revisiones" />
          <NavItem active={activeTab === 'bitacora'} onClick={() => setActiveTab('bitacora')} icon={<FileText size={18} />} label="Bitacora" />
        </div>

        <div className="p-6 border-t border-slate-800">
          <div className="flex items-center gap-3 text-slate-400">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold">HS</div>
            <div className="overflow-hidden">
              <p className="text-xs font-semibold text-slate-200 truncate">Farmacia de Guardia</p>
              <p className="text-[10px] opacity-60">ID: 2492-CR</p>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 p-6 md:p-10 overflow-y-auto max-h-screen">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h2 className="text-2xl font-bold text-slate-800 tracking-tight">
              {activeTab === 'dashboard'
                ? 'Resumen Operativo'
                : activeTab === 'kardex'
                  ? 'Kardex de Sustancias Controladas'
                  : activeTab === 'auditoria'
                    ? 'Auditoria de Expedientes'
                    : activeTab === 'bitacora'
                      ? 'Bitacora de Jornada'
                      : 'Resumen Operativo'}
            </h2>
            <p className="text-slate-500 text-sm">Control centralizado y validacion farmacoterapeutica.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border ${
                cloudStatus === 'Sincronizado'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : cloudStatus === 'Sin conexion'
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {cloudStatus}
            </span>
            {pendingCount > 0 && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                Pendientes: {pendingCount}
              </span>
            )}
            {pendingCount > 0 && (
              <button
                onClick={flushWriteQueue}
                className="bg-amber-600 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-amber-700"
              >
                Reintentar
              </button>
            )}
            {syncError && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
                {syncError}
              </span>
            )}
            {syncErrors.length > 0 && (
              <button
                onClick={() => setModalType('sync-log')}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
              >
                Ver Log
              </button>
            )}
            {authUser && (
              <button
                onClick={async () => {
                  await signOut(auth);
                  setTransactions([]);
                  setExpedientes([]);
                  setBitacora([]);
                  setMedications(INITIAL_MEDICATIONS);
                  setServices(INITIAL_SERVICES);
                  setPharmacists(INITIAL_PHARMACISTS);
                  setCondiciones(INITIAL_CONDICIONES);
                  setSelectedMedId(INITIAL_MEDICATIONS[0].id);
                  setPendingCount(0);
                  setSyncErrors([]);
                  pendingWritesRef.current = [];
                  isFlushingRef.current = false;
                  if (retryTimeoutRef.current) {
                    clearTimeout(retryTimeoutRef.current);
                    retryTimeoutRef.current = null;
                  }
                  setCloudStatus('Sin sesion');
                  localStorage.removeItem('pharmaControlData');
                  localStorage.removeItem('pharmaPendingWrites');
                }}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
              >
                Salir
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setShowCatalogMenu((prev) => !prev)}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
              >
                Catalogos
              </button>
              {showCatalogMenu && (
                <div className="absolute right-0 mt-2 w-64 rounded-lg border border-slate-200 bg-white shadow-lg z-20">
                  <div className="px-3 py-2 text-[10px] font-bold uppercase text-slate-400">Servicios</div>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('service-add');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Nuevo Servicio
                  </button>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('service-manage');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Eliminar Servicio
                  </button>
                  <div className="px-3 py-2 text-[10px] font-bold uppercase text-slate-400 border-t border-slate-100">Farmaceuticos</div>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('pharmacist-add');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Nuevo Farmaceutico
                  </button>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('pharmacist-manage');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Eliminar Farmaceutico
                  </button>
                  <div className="px-3 py-2 text-[10px] font-bold uppercase text-slate-400 border-t border-slate-100">Condiciones</div>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('condition-add');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Nueva Condicion
                  </button>
                  <button
                    onClick={() => {
                      setShowCatalogMenu(false);
                      setIsQuickIngreso(false);
                      setModalType('condition-manage');
                      setShowModal(true);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Eliminar Condicion
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setModalType(activeTab === 'auditoria' ? 'auditoria' : activeTab === 'bitacora' ? 'bitacora' : 'kardex');
                setPrefillKardexType('');
                setIsQuickIngreso(false);
                setShowCatalogMenu(false);
                setRxTypeValue('CERRADA');
                setShowModal(true);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg font-semibold text-sm flex items-center gap-2 transition-all shadow-sm active:scale-95"
            >
              <PlusCircle size={18} /> Nuevo Registro
            </button>
          </div>
        </header>

        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <StatSimple title="Total Inventario" value={stats.totalStock} sub="Ampollas" icon={<Package className="text-blue-600" />} />
              <StatSimple title="Revisiones Hoy" value={stats.todayReviews} sub="Expedientes" icon={<CheckCircle2 className="text-emerald-600" />} />
              <StatSimple title="Alertas Stock" value={stats.lowStock} sub="Farmacos" icon={<AlertTriangle className="text-rose-600" />} isAlert={stats.lowStock > 0} />
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h3 className="font-bold text-slate-700 text-sm">Estado Actual de Inventario</h3>
                <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                  <Clock size={12} /> Activo
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-slate-100">
                {currentInventory.map((med) => (
                  <div
                    key={med.id}
                    className="bg-white p-6 hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => {
                      setSelectedMedId(med.id);
                      setActiveTab('kardex');
                    }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <p className="font-bold text-slate-800 text-sm">{med.name}</p>
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-500 uppercase">{med.type.slice(0, 4)}</span>
                    </div>
                    <div className="flex items-end gap-2">
                      <span className={`text-2xl font-bold ${med.stock < 15 ? 'text-rose-600' : 'text-slate-900'}`}>{med.stock}</span>
                      <span className="text-[10px] text-slate-400 font-bold mb-1 uppercase tracking-wider">Unidades</span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      <span>Min recomendado</span>
                      <span className="text-slate-700">{med.minRecommended}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      <span>Cuota</span>
                      <span className="text-slate-700">{med.quota ?? 0}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'kardex' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between shadow-sm">
              <div className="flex items-center gap-3">
                <div className="bg-blue-50 p-2 rounded-lg text-blue-600">
                  <Filter size={18} />
                </div>
                <select
                  value={selectedMedId}
                  onChange={(e) => setSelectedMedId(e.target.value)}
                  className="bg-transparent border-0 font-bold text-slate-800 focus:ring-0 text-sm cursor-pointer"
                >
                  {sortedMedications.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setModalType('med-add');
                      setIsQuickIngreso(false);
                      setShowModal(true);
                    }}
                    className="bg-slate-900 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-800"
                  >
                    Nuevo Medicamento
                  </button>
                  <button
                    onClick={() => {
                      setPrefillKardexType('IN');
                      setIsQuickIngreso(true);
                      setModalType('kardex');
                      setShowCatalogMenu(false);
                      setShowModal(true);
                    }}
                    className="bg-emerald-600 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-emerald-700"
                  >
                    Ingreso Medicamento
                  </button>
                  <button
                    onClick={() => {
                      setModalType('cierre');
                      setShowCatalogMenu(false);
                      setShowModal(true);
                    }}
                    className="bg-amber-500 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-amber-600"
                  >
                    Cierre Inventario
                  </button>
                  <button
                    onClick={() => {
                      setEditingMedId(selectedMedId);
                      setModalType('med-edit');
                      setIsQuickIngreso(false);
                      setShowModal(true);
                    }}
                    className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => {
                      const med = medications.find((m) => m.id === selectedMedId);
                      const confirmDelete = window.confirm(`Eliminar ${med?.name || 'medicamento'}? Se borraran sus movimientos.`);
                      if (!confirmDelete) return;
                      setTransactions(transactions.filter((t) => t.medId !== selectedMedId));
                      const updated = medications.filter((m) => m.id !== selectedMedId);
                      setMedications(updated);
                      setSelectedMedId(updated[0]?.id || '');
                    }}
                    className="bg-rose-600 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                  >
                    Eliminar
                  </button>
                </div>
                <div className="text-right">
                  <p className="text-slate-400 font-bold uppercase text-[9px]">Saldo Actual</p>
                  <p className="font-bold text-blue-600 text-lg">{currentInventory.find((m) => m.id === selectedMedId)?.stock}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Fecha</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Movimiento</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio / Cama</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Tipo de Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Acciones</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaceutico</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recentTransactions.map((t) => (
                    <tr
                      key={t.id}
                      className={`hover:bg-slate-50/50 ${
                        t.isCierre
                          ? t.cierreTurno === 'CIERRE 24 HORAS'
                            ? 'bg-rose-50'
                            : 'bg-amber-50'
                          : ''
                      }`}
                    >
                        <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                        <td className="px-6 py-4 text-center">
                          {t.isCierre ? (
                            <span className="font-bold uppercase text-amber-700">Cierre</span>
                          ) : (
                            <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                              {t.amount}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-700 text-center">
                          {t.isCierre ? (
                            <span className="font-bold text-slate-700">{t.cierreTurno}</span>
                          ) : (
                            <>
                              {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                            </>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {t.isCierre ? (
                            <span className="text-xs font-bold uppercase text-slate-600">Total Medicamento: {t.totalMedicamento}</span>
                          ) : t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
                            <button
                              type="button"
                              onClick={() => handleOpenRxUse(t)}
                              className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                              title="Registrar nuevo rebajo"
                            >
                              {t.rxUsed || 0} de {t.rxQuantity}
                            </button>
                          ) : (
                            <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                          {t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex gap-2 justify-center">
                            {!t.isCierre && (
                              <button
                                onClick={() => {
                                  setEditingTransactionId(t.id);
                                  setModalType('kardex-edit');
                                  setRxTypeValue(t.rxType || 'CERRADA');
                                  setIsQuickIngreso(false);
                                  setShowModal(true);
                                }}
                                className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                              >
                                Editar
                              </button>
                            )}
                            <button
                              onClick={() => {
                                const confirmDelete = window.confirm('Eliminar este movimiento?');
                                if (!confirmDelete) return;
                                setTransactions(transactions.filter((tx) => tx.id !== t.id));
                                enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                              }}
                              className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">{t.pharmacist}</td>
                    </tr>
                  ))}
                  {recentTransactions.length === 0 && (
                    <tr>
                      <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={7}>
                        Sin rebajos en la ultima semana.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h3 className="font-bold text-slate-700 text-sm">Historico (anteriores a 7 dias)</h3>
              </div>
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Fecha</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Movimiento</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio / Cama</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Tipo de Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Acciones</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaceutico</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {historicTransactions.map((t) => (
                    <tr
                      key={t.id}
                      className={`hover:bg-slate-50/50 ${
                        t.isCierre
                          ? t.cierreTurno === 'CIERRE 24 HORAS'
                            ? 'bg-rose-50'
                            : 'bg-amber-50'
                          : ''
                      }`}
                    >
                      <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                      <td className="px-6 py-4 text-center">
                        {t.isCierre ? (
                          <span className="font-bold uppercase text-amber-700">Cierre</span>
                        ) : (
                          <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                            {t.amount}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-700 text-center">
                        {t.isCierre ? (
                          <span className="font-bold text-slate-700">{t.cierreTurno}</span>
                        ) : (
                          <>
                            {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                          </>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {t.isCierre ? (
                          <span className="text-xs font-bold uppercase text-slate-600">Total Medicamento: {t.totalMedicamento}</span>
                        ) : t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleOpenRxUse(t)}
                            className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                            title="Registrar nuevo rebajo"
                          >
                            {t.rxUsed || 0} de {t.rxQuantity}
                          </button>
                        ) : (
                          <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                        {t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 justify-center">
                          {!t.isCierre && (
                            <button
                              onClick={() => {
                                setEditingTransactionId(t.id);
                                setModalType('kardex-edit');
                                setRxTypeValue(t.rxType || 'CERRADA');
                                setIsQuickIngreso(false);
                                setShowModal(true);
                              }}
                              className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                            >
                              Editar
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const confirmDelete = window.confirm('Eliminar este movimiento?');
                              if (!confirmDelete) return;
                              setTransactions(transactions.filter((tx) => tx.id !== t.id));
                              enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                            }}
                            className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                          >
                            Eliminar
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">{t.pharmacist}</td>
                    </tr>
                  ))}
                  {historicTransactions.length === 0 && (
                    <tr>
                      <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={7}>
                        Sin historico anterior.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'auditoria' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Fecha</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Receta</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Cedula</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaco / Dosis</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Estado</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Acciones</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaceutico</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {expedientes.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50/50">
                    <td className="px-6 py-4 text-slate-500 text-center">{e.fecha}</td>
                    <td className="px-6 py-4 text-center text-xs font-bold text-slate-700">{e.servicio}</td>
                    <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">{e.receta || '---'}</td>
                    <td className="px-6 py-4 font-mono font-bold text-slate-700 text-center">{e.cedula}</td>
                    <td className="px-6 py-4 text-center">
                      <p className="font-mono font-bold text-slate-800">{e.medicamento}</p>
                      <p className="text-[10px] text-slate-400">{e.dosis}</p>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span
                        className={`px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider ${
                          e.condicion === 'VALIDACION' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
                        }`}
                      >
                        {e.condicion}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => {
                            setEditingExpedienteId(e.id);
                            setModalType('auditoria-edit');
                            setIsQuickIngreso(false);
                            setShowModal(true);
                          }}
                          className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => {
                            const confirmDelete = window.confirm('Eliminar este expediente?');
                            if (!confirmDelete) return;
                            setExpedientes(expedientes.filter((exp) => exp.id !== e.id));
                            enqueueWrite({ type: 'delete', collection: 'expedientes', id: e.id });
                          }}
                          className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                        >
                          Eliminar
                        </button>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">{e.farmaceutico}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'bitacora' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Fecha</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Situacion</th>
                  <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Responsable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bitacora.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/50">
                    <td className="px-6 py-4 text-slate-500 text-center">{b.fecha}</td>
                    <td className="px-6 py-4 text-center text-xs font-bold text-slate-700">{b.servicio}</td>
                    <td className="px-6 py-4 text-center">
                      <p className="font-bold text-slate-800">{b.titulo}</p>
                      <p className="text-[10px] text-slate-400">{b.detalle}</p>
                    </td>
                    <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">{b.responsable}</td>
                  </tr>
                ))}
                {bitacora.length === 0 && (
                  <tr>
                    <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={4}>
                      Sin registros en la bitacora.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

      </main>

      {!authUser && !authLoading && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl overflow-hidden border border-slate-200">
            <div className="p-6 border-b border-slate-100 bg-slate-50">
              <h3 className="font-bold text-slate-800 uppercase tracking-tight text-sm">Iniciar Sesion</h3>
              <p className="text-xs text-slate-500 mt-1">Use su correo y contrasena para sincronizar entre equipos.</p>
            </div>
            <div className="p-6 space-y-4">
              <InputLabel label="Correo" name="authEmail" type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
              <InputLabel label="Contrasena" name="authPassword" type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} />
              {authError && <p className="text-xs font-bold text-rose-600">{authError}</p>}
              <button
                onClick={handleGoogleAuth}
                className="w-full bg-white border border-slate-200 text-slate-700 py-3 rounded-lg font-bold text-xs shadow-sm hover:bg-slate-50 transition-all uppercase tracking-widest"
              >
                Google
              </button>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleAuth('login')}
                  className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-xs shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest"
                >
                  Ingresar
                </button>
                <button
                  onClick={() => handleAuth('register')}
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold text-xs shadow-sm hover:bg-blue-700 transition-all uppercase tracking-widest"
                >
                  Crear Usuario
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {authUser && (authLoading || cloudLoading || !cloudReady) && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-40">
          <div className="bg-white rounded-xl px-6 py-4 shadow-lg border border-slate-200">
            <p className="text-sm font-bold text-slate-700">Cargando datos...</p>
          </div>
        </div>
      )}

      {/* Simplified Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl w-full max-w-xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-slate-800 uppercase tracking-tight text-sm">
                {modalType === 'auditoria'
                  ? 'Nuevo Registro de Auditoria'
                  : modalType === 'kardex'
                    ? 'Nuevo Registro de Kardex'
                    : modalType === 'kardex-edit'
                      ? 'Editar Movimiento'
                      : modalType === 'auditoria-edit'
                        ? 'Editar Expediente'
                        : modalType === 'bitacora'
                          ? 'Nuevo Registro de Bitacora'
                        : modalType === 'cierre'
                          ? 'Cierre de Inventario'
                        : modalType === 'sync-log'
                          ? 'Log de Sincronizacion'
                        : modalType === 'med-edit'
                          ? 'Editar Medicamento'
                          : modalType === 'service-add'
                            ? 'Nuevo Servicio'
                            : modalType === 'service-manage'
                              ? 'Eliminar Servicio'
                              : modalType === 'pharmacist-add'
                                ? 'Nuevo Farmaceutico'
                                : modalType === 'pharmacist-manage'
                                  ? 'Eliminar Farmaceutico'
                                  : modalType === 'condition-add'
                                    ? 'Nueva Condicion'
                                    : modalType === 'condition-manage'
                                      ? 'Eliminar Condicion'
                                      : 'Nuevo Medicamento'}
              </h3>
                  <button
                    onClick={() => {
                      setShowModal(false);
                      setEditingMedId(null);
                      setEditingTransactionId(null);
                      setEditingExpedienteId(null);
                      setPrefillKardexType('');
                      setIsQuickIngreso(false);
                      setRxTypeValue('CERRADA');
                    }}
                    className="text-slate-400 hover:text-slate-600"
                  >
                x
              </button>
            </div>

            <form
              onSubmit={
                modalType === 'pharmacist-manage' ||
                modalType === 'condition-manage' ||
                modalType === 'service-manage' ||
                modalType === 'sync-log'
                  ? (e) => e.preventDefault()
                  : handleSave
              }
              className="p-8 space-y-4"
            >
              {modalType === 'auditoria' || modalType === 'auditoria-edit' ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <InputLabel
                      label="Cedula Paciente"
                      name="cedula"
                      required
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.cedula || ''}
                    />
                    <InputLabel
                      label="N Receta"
                      name="receta"
                      required
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.receta || ''}
                    />
                  </div>
                  <SelectLabel
                    label="Servicio"
                    name="servicio"
                    options={services}
                    defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.servicio || services[0]}
                  />
                  <SelectLabel
                    label="Medicamento"
                    name="medicamento"
                    options={sortedMedications.map((m) => m.name)}
                    defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.medicamento || sortedMedications[0]?.name}
                  />
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Dosis y Via</label>
                    <textarea
                      name="dosis"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none h-20"
                      required
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.dosis || ''}
                    ></textarea>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <SelectLabel
                      label="Condicion"
                      name="condicion"
                      options={condiciones}
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.condicion || condiciones[0]}
                    />
                    <SelectLabel
                      label="Farmaceutico"
                      name="farmaceutico"
                      options={pharmacists}
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.farmaceutico || pharmacists[0]}
                    />
                  </div>
                </>
              ) : modalType === 'cierre' ? (
                <>
                  <SelectLabel
                    label="Turno"
                    name="turno"
                    options={['SEGUNDO', 'TERCERO', 'CIERRE 24 HORAS']}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <InputLabel label="Total de Recetas" name="totalRecetas" type="number" required />
                    <InputLabel label="Total de Medicamento" name="totalMedicamento" type="number" required />
                  </div>
                  <SelectLabel label="Farmaceutico" name="farmaceutico" options={pharmacists} />
                </>
              ) : modalType === 'bitacora' ? (
                <>
                  <SelectLabel label="Servicio" name="servicio" options={services} />
                  <InputLabel label="Titulo" name="titulo" required />
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Detalle</label>
                    <textarea
                      name="detalle"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none h-24"
                      required
                    ></textarea>
                  </div>
                  <SelectLabel label="Responsable" name="responsable" options={pharmacists} />
                </>
              ) : modalType === 'kardex' || modalType === 'kardex-edit' ? (
                <>
                  <SelectLabel
                    label="Medicamento"
                    name="medicationId"
                    options={sortedMedications.map((m) => ({ value: m.id, label: m.name }))}
                    isObject
                    defaultValue={transactions.find((t) => t.id === editingTransactionId)?.medId || selectedMedId}
                  />
                  {isQuickIngreso ? (
                    <div className="grid grid-cols-2 gap-4">
                      <InputLabel
                        label="Cantidad"
                        name="amount"
                        type="number"
                        required
                        defaultValue={transactions.find((t) => t.id === editingTransactionId)?.amount || ''}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <SelectLabel
                          label="Tipo de Receta"
                          name="rxType"
                          options={[
                            { value: 'CERRADA', label: 'Cerrada' },
                            { value: 'ABIERTA', label: 'Abierta' },
                          ]}
                          isObject
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.rxType || 'CERRADA'}
                          onChange={(e) => setRxTypeValue(e.target.value)}
                        />
                        {rxTypeValue === 'ABIERTA' ? (
                          <InputLabel
                            label="Cantidad Receta"
                            name="rxQuantity"
                            type="number"
                            required
                            defaultValue={transactions.find((t) => t.id === editingTransactionId)?.rxQuantity || ''}
                          />
                        ) : (
                          <div />
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <InputLabel
                          label="Cantidad"
                          name="amount"
                          type="number"
                          required
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.amount || ''}
                        />
                        <div />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <SelectLabel
                          label="Servicio"
                          name="service"
                          options={services}
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.service || services[0]}
                        />
                        <InputLabel
                          label="Cama"
                          name="cama"
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.cama || ''}
                        />
                      </div>
                      <InputLabel
                        label="N Receta / Comprobante"
                        name="prescription"
                        defaultValue={transactions.find((t) => t.id === editingTransactionId)?.prescription || ''}
                      />
                      <SelectLabel
                        label="Farmaceutico"
                        name="pharmacist"
                        options={pharmacists}
                        defaultValue={transactions.find((t) => t.id === editingTransactionId)?.pharmacist || pharmacists[0]}
                      />
                    </>
                  )}
                </>
              ) : modalType === 'sync-log' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Ultimos errores de sincronizacion (max 50).</p>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {syncErrors.map((err, idx) => (
                      <div key={`${err.id}-${idx}`} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs font-bold text-slate-700">
                          [{err.time}] {err.collection}/{err.id} ({err.type})
                        </span>
                      </div>
                    ))}
                    {syncErrors.length === 0 && <p className="text-xs text-slate-400">Sin errores registrados.</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest mt-4"
                  >
                    Cerrar
                  </button>
                </div>
              ) : modalType === 'service-add' ? (
                <>
                  <InputLabel label="Nombre del Servicio" name="serviceName" required />
                </>
              ) : modalType === 'pharmacist-add' ? (
                <>
                  <InputLabel label="Nombre del Farmaceutico" name="pharmacistName" required />
                </>
              ) : modalType === 'service-manage' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Eliminar un servicio no afecta el historial.</p>
                  <div className="space-y-2">
                    {services.map((name) => (
                      <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs font-bold text-slate-700">{name}</span>
                        <button
                          type="button"
                          onClick={() => setServices(services.filter((s) => s !== name))}
                          className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                        >
                          Eliminar
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest mt-4"
                  >
                    Cerrar
                  </button>
                </div>
              ) : modalType === 'condition-add' ? (
                <>
                  <InputLabel label="Nombre de la Condicion" name="conditionName" required />
                </>
              ) : modalType === 'pharmacist-manage' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Eliminar un farmaceutico no afecta el historial de rebajos.</p>
                  <div className="space-y-2">
                    {pharmacists.map((name) => (
                      <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs font-bold text-slate-700">{name}</span>
                        <button
                          type="button"
                          onClick={() => setPharmacists(pharmacists.filter((p) => p !== name))}
                          className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                        >
                          Eliminar
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest mt-4"
                  >
                    Cerrar
                  </button>
                </div>
              ) : modalType === 'condition-manage' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Eliminar una condicion no afecta el historial.</p>
                  <div className="space-y-2">
                    {condiciones.map((name) => (
                      <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs font-bold text-slate-700">{name}</span>
                        <button
                          type="button"
                          onClick={() => setCondiciones(condiciones.filter((c) => c !== name))}
                          className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                        >
                          Eliminar
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest mt-4"
                  >
                    Cerrar
                  </button>
                </div>
              ) : (
                <>
                  <InputLabel
                    label="Nombre del Medicamento"
                    name="medName"
                    required
                    defaultValue={medications.find((m) => m.id === editingMedId)?.name || ''}
                  />
                  <SelectLabel
                    label="Tipo"
                    name="medType"
                    options={MED_TYPES}
                    defaultValue={medications.find((m) => m.id === editingMedId)?.type || MED_TYPES[0]}
                  />
                  <InputLabel
                    label="Precio Unitario (CRC)"
                    name="unitPrice"
                    type="text"
                    inputMode="decimal"
                    placeholder="0,00"
                    defaultValue={formatCurrency(medications.find((m) => m.id === editingMedId)?.unitPrice ?? '')}
                    onFocus={(e) => {
                      const value = e.target.value;
                      if (!value) return;
                      e.target.value = value.replace(/\./g, '').replace(',', '.');
                    }}
                    onBlur={(e) => {
                      const value = e.target.value;
                      if (!value) return;
                      e.target.value = formatCurrency(parseCurrency(value));
                    }}
                  />
                  <InputLabel
                    label="Cuota"
                    name="quota"
                    type="number"
                    defaultValue={medications.find((m) => m.id === editingMedId)?.quota ?? ''}
                  />
                </>
              )}
              {modalType !== 'pharmacist-manage' &&
                modalType !== 'condition-manage' &&
                modalType !== 'service-manage' &&
                modalType !== 'sync-log' && (
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-blue-700 transition-all uppercase tracking-widest mt-4"
                >
                  Guardar Registro
                </button>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// --- SMALL COMPONENTS ---
const NavItem = ({ active, icon, label, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-sm font-semibold ${
      active ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
    }`}
  >
    <span>{icon}</span>
    <span className="tracking-tight">{label}</span>
  </button>
);

const StatSimple = ({ title, value, sub, icon, isAlert }) => (
  <div className={`p-6 bg-white rounded-xl border shadow-sm transition-all ${isAlert ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200'}`}>
    <div className="flex justify-between items-center mb-4">
      <div className="bg-slate-50 p-2 rounded-lg border border-slate-100">{icon}</div>
      {isAlert && <span className="text-[9px] font-bold text-rose-600 bg-rose-100 px-2 py-0.5 rounded uppercase">Atencion</span>}
    </div>
    <div className="flex items-baseline gap-2">
      <p className={`text-3xl font-bold tracking-tighter ${isAlert ? 'text-rose-600' : 'text-slate-800'}`}>{value}</p>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{sub}</p>
    </div>
    <p className="text-xs font-medium text-slate-500 mt-1 uppercase tracking-tighter">{title}</p>
  </div>
);

const InputLabel = ({ label, ...props }) => (
  <div className="space-y-1">
    <label className="text-[10px] font-bold text-slate-500 uppercase">{label}</label>
    <input {...props} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium" />
  </div>
);

const SelectLabel = ({ label, options, isObject, ...props }) => (
  <div className="space-y-1">
    <label className="text-[10px] font-bold text-slate-500 uppercase">{label}</label>
    <select {...props} className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium">
      {options.map((opt, i) => (
        <option key={i} value={isObject ? opt.value : opt}>
          {isObject ? opt.label : opt}
        </option>
      ))}
    </select>
  </div>
);

export default App;
