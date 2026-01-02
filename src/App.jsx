import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Database,
  Filter,
  History,
  Package,
  PlusCircle,
  Send,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { db, ensureAnonymousSignIn } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

// --- CONFIGURACION ---
const apiKey = '';
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

const INITIAL_MEDICATIONS = [
  { id: 'morf-15', name: 'MORFINA 15 MG', type: 'Estupefaciente' },
  { id: 'fent-50', name: 'FENTANYL 50 MCG', type: 'Estupefaciente' },
  { id: 'diaz-10', name: 'DIAZEPAM 10 MG', type: 'Psicotropico' },
  { id: 'midaz-15', name: 'MIDAZOLAM 15 MG', type: 'Psicotropico' },
  { id: 'clon-2', name: 'CLONAZEPAM 2 MG', type: 'Psicotropico' },
  { id: 'feno-50', name: 'FENOBARBITAL 50 MG', type: 'Psicotropico' },
];

const INITIAL_SERVICES = ['EMERGENCIAS', 'MEDICINA', 'CIRUGIA', 'PEDIATRIA', 'UCI', 'CLINICA DEL DOLOR'];
const INITIAL_PHARMACISTS = ['2492 ESTHER HERNANDEZ', '2488 VIVIANA ESQUIVEL', '3632 GINNETTE MONTERO', '4511 JEANNETTE SALAZAR'];
const CONDICIONES = ['VALIDACION', 'INCONSISTENTE', 'SUSPENDIDA', 'EGRESO'];
const MED_TYPES = ['Estupefaciente', 'Psicotropico'];

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [medications, setMedications] = useState(INITIAL_MEDICATIONS);
  const [selectedMedId, setSelectedMedId] = useState(INITIAL_MEDICATIONS[0].id);
  const [editingMedId, setEditingMedId] = useState(null);
  const [editingTransactionId, setEditingTransactionId] = useState(null);
  const [editingExpedienteId, setEditingExpedienteId] = useState(null);
  const [services, setServices] = useState(INITIAL_SERVICES);
  const [pharmacists, setPharmacists] = useState(INITIAL_PHARMACISTS);
  const [rxTypeValue, setRxTypeValue] = useState('CERRADA');
  const [cloudStatus, setCloudStatus] = useState('Sincronizando...');

  const toUpper = (value) => (value ? value.toString().toUpperCase().trim() : '');
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
  };

  useEffect(() => {
    ensureAnonymousSignIn().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrateFromCloud = async () => {
      try {
        const user = await ensureAnonymousSignIn();
        const ref = doc(db, 'appState', user.uid);
        const snap = await getDoc(ref);
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          if (data.transactions?.length) setTransactions(data.transactions);
          if (data.expedientes?.length) setExpedientes(data.expedientes);
          if (data.medications?.length) setMedications(data.medications);
          if (data.services?.length) setServices(data.services);
          if (data.pharmacists?.length) setPharmacists(data.pharmacists);
          if (data.selectedMedId) setSelectedMedId(data.selectedMedId);
        }
      } catch {
        try {
          const stored = JSON.parse(localStorage.getItem('pharmaControlData') || '{}');
          if (stored.transactions?.length) setTransactions(stored.transactions);
          if (stored.expedientes?.length) setExpedientes(stored.expedientes);
          if (stored.medications?.length) setMedications(stored.medications);
          if (stored.services?.length) setServices(stored.services);
          if (stored.pharmacists?.length) setPharmacists(stored.pharmacists);
          if (stored.selectedMedId) setSelectedMedId(stored.selectedMedId);
        } catch {
          localStorage.removeItem('pharmaControlData');
        }
      } finally {
        if (!cancelled) {
          setCloudReady(true);
          setCloudStatus('Sincronizado');
        }
      }
    };
    hydrateFromCloud();
    return () => {
      cancelled = true;
    };
  }, []);

  // Data States
  const [transactions, setTransactions] = useState([
    {
      id: 1,
      date: '27/08/2025 13:34',
      medId: 'morf-15',
      type: 'IN',
      amount: 184,
      service: 'INVENTARIO',
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

  // AI States
  const [aiMessages, setAiMessages] = useState([
    { role: 'assistant', text: 'Asistente PharmaAI activo. Desea un resumen del inventario o validar una dosis?' },
  ]);
  const [isTyping, setIsTyping] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [cloudReady, setCloudReady] = useState(false);

  useEffect(() => {
    const payload = {
      transactions,
      expedientes,
      medications,
      services,
      pharmacists,
      selectedMedId,
    };
    localStorage.setItem('pharmaControlData', JSON.stringify(payload));
    if (!cloudReady) return;
    ensureAnonymousSignIn()
      .then((user) => {
        setCloudStatus('Sincronizando...');
        return setDoc(doc(db, 'appState', user.uid), payload, { merge: true });
      })
      .then(() => setCloudStatus('Sincronizado'))
      .catch(() => setCloudStatus('Sin conexion'));
  }, [transactions, expedientes, medications, services, pharmacists, selectedMedId]);

  // Computations
  const currentInventory = useMemo(() => {
    return medications.map((med) => {
      const medTransactions = transactions.filter((t) => t.medId === med.id);
      const stock = medTransactions.reduce((acc, t) => (t.type === 'IN' ? acc + t.amount : acc - t.amount), 0);
      return { ...med, stock };
    });
  }, [transactions, medications]);

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
      const when = parseDateTime(t.date);
      if (when && when >= cutoff) {
        recent.push(t);
      } else {
        historic.push(t);
      }
    });
    return { recentTransactions: recent, historicTransactions: historic };
  }, [transactions, selectedMedId]);

  // AI Logic
  const handleAiChat = async (e) => {
    e.preventDefault();
    const input = e.target.elements.userInput.value;
    if (!input.trim() || !apiKey) return;
    const newMessages = [...aiMessages, { role: 'user', text: input }];
    setAiMessages(newMessages);
    e.target.reset();
    setIsTyping(true);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input }] }],
            systemInstruction: {
              parts: [{ text: `Eres un asistente de farmacia hospitalaria. Inventario: ${currentInventory.map((m) => `${m.name}: ${m.stock}`).join(', ')}.` }],
            },
          }),
        },
      );
      const data = await response.json();
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Error de respuesta.';
      setAiMessages([...newMessages, { role: 'assistant', text: aiText }]);
    } catch {
      setAiMessages([...newMessages, { role: 'assistant', text: 'Error de conexion con IA.' }]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const now = new Date().toLocaleString('es-CR', { hour12: false }).slice(0, 16);

    if (modalType === 'kardex') {
      const rxType = formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const medId = formData.get('medicationId');
      const prescription = toUpper(formData.get('prescription'));
      const rxUsed =
        rxType === 'ABIERTA' && rxQuantity > 0 ? nextOpenRxUse(transactions, medId, prescription, rxQuantity) : 0;
      const newTransaction = {
        id: Date.now(),
        date: now,
        medId,
        type: formData.get('type'),
        amount: parseInt(formData.get('amount'), 10),
        service: toUpper(formData.get('service')),
        cama: toUpper(formData.get('cama')),
        prescription,
        rxType,
        rxQuantity,
        rxUsed,
        pharmacist: toUpper(formData.get('pharmacist')),
      };
      setTransactions([newTransaction, ...transactions]);
    } else if (modalType === 'kardex-edit') {
      const current = transactions.find((t) => t.id === editingTransactionId);
      const rxType = formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const rxUsed = rxType === 'ABIERTA' ? Math.min(current?.rxUsed ?? 0, rxQuantity) : 0;
      const updated = {
        id: editingTransactionId,
        date: now,
        medId: formData.get('medicationId'),
        type: formData.get('type'),
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
    } else if (modalType === 'auditoria') {
      const newExp = {
        id: Date.now(),
        fecha: now,
        servicio: toUpper(formData.get('servicio')),
        cedula: toUpper(formData.get('cedula')),
        receta: toUpper(formData.get('receta')),
        medicamento: toUpper(formData.get('medicamento')),
        dosis: toUpper(formData.get('dosis')),
        condicion: toUpper(formData.get('condicion')),
        farmaceutico: toUpper(formData.get('farmaceutico')),
      };
      setExpedientes([newExp, ...expedientes]);
    } else if (modalType === 'auditoria-edit') {
      const current = expedientes.find((e) => e.id === editingExpedienteId);
      const updated = {
        id: editingExpedienteId,
        fecha: current?.fecha || now,
        servicio: toUpper(formData.get('servicio')),
        cedula: toUpper(formData.get('cedula')),
        receta: toUpper(formData.get('receta')),
        medicamento: toUpper(formData.get('medicamento')),
        dosis: toUpper(formData.get('dosis')),
        condicion: toUpper(formData.get('condicion')),
        farmaceutico: toUpper(formData.get('farmaceutico')),
      };
      setExpedientes(expedientes.map((e) => (e.id === editingExpedienteId ? updated : e)));
    } else if (modalType === 'med-add') {
      const newId = `med-${Date.now()}`;
      const newMed = {
        id: newId,
        name: toUpper(formData.get('medName')),
        type: formData.get('medType'),
      };
      setMedications([newMed, ...medications]);
      setSelectedMedId(newId);
    } else if (modalType === 'med-edit') {
      const updated = {
        id: editingMedId,
        name: toUpper(formData.get('medName')),
        type: formData.get('medType'),
      };
      setMedications(medications.map((m) => (m.id === editingMedId ? updated : m)));
    } else if (modalType === 'service-add') {
      const newService = toUpper(formData.get('serviceName'));
      setServices([newService, ...services]);
    } else if (modalType === 'pharmacist-add') {
      const newPharmacist = toUpper(formData.get('pharmacistName'));
      setPharmacists([newPharmacist, ...pharmacists]);
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
            <h1 className="text-lg font-bold tracking-tight">PharmaControl</h1>
          </div>
          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-widest border-l border-blue-600 pl-2">Hospital San Vicente</p>
        </div>

        <div className="flex-1 px-4 space-y-1">
          <NavItem active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<Activity size={18} />} label="Dashboard" />
          <NavItem active={activeTab === 'kardex'} onClick={() => setActiveTab('kardex')} icon={<History size={18} />} label="Kardex Individual" />
          <NavItem active={activeTab === 'auditoria'} onClick={() => setActiveTab('auditoria')} icon={<ShieldCheck size={18} />} label="Revisiones" />
          <NavItem active={activeTab === 'ai'} onClick={() => setActiveTab('ai')} icon={<BrainCircuit size={18} />} label="Asistente AI" />
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
                    : 'Asistente Inteligente'}
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
            <button
              onClick={() => {
                setModalType('service-add');
                setShowModal(true);
              }}
              className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
            >
              Nuevo Servicio
            </button>
            <button
              onClick={() => {
                setModalType('pharmacist-add');
                setShowModal(true);
              }}
              className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
            >
              Nuevo Farmaceutico
            </button>
            <button
              onClick={() => {
                setModalType('pharmacist-manage');
                setShowModal(true);
              }}
              className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
            >
              Eliminar Farmaceutico
            </button>
            <button
              onClick={() => {
                setModalType(activeTab === 'auditoria' ? 'auditoria' : 'kardex');
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
                  {medications.map((m) => (
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
                      setShowModal(true);
                    }}
                    className="bg-slate-900 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-800"
                  >
                    Nuevo Medicamento
                  </button>
                  <button
                    onClick={() => {
                      setEditingMedId(selectedMedId);
                      setModalType('med-edit');
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
                    <tr key={t.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                        <td className="px-6 py-4 text-center">
                          <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                            {t.amount}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-700 text-center">
                          {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
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
                        <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">{t.prescription || '---'}</td>
                        <td className="px-6 py-4">
                          <div className="flex gap-2 justify-center">
                            <button
                              onClick={() => {
                                setEditingTransactionId(t.id);
                                setModalType('kardex-edit');
                                setRxTypeValue(t.rxType || 'CERRADA');
                                setShowModal(true);
                              }}
                              className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => {
                                const confirmDelete = window.confirm('Eliminar este movimiento?');
                                if (!confirmDelete) return;
                                setTransactions(transactions.filter((tx) => tx.id !== t.id));
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
                    <tr key={t.id} className="hover:bg-slate-50/50">
                      <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                      <td className="px-6 py-4 text-center">
                        <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                          {t.amount}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-700 text-center">
                        {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
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
                      <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">{t.prescription || '---'}</td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 justify-center">
                          <button
                            onClick={() => {
                              setEditingTransactionId(t.id);
                              setModalType('kardex-edit');
                              setRxTypeValue(t.rxType || 'CERRADA');
                              setShowModal(true);
                            }}
                            className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => {
                              const confirmDelete = window.confirm('Eliminar este movimiento?');
                              if (!confirmDelete) return;
                              setTransactions(transactions.filter((tx) => tx.id !== t.id));
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
                    <td className="px-6 py-4 font-mono font-bold text-slate-700 text-center">{e.cedula}</td>
                    <td className="px-6 py-4 text-center">
                      <p className="font-bold text-slate-800">{e.medicamento}</p>
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

        {activeTab === 'ai' && (
          <div className="max-w-4xl mx-auto h-[600px] bg-white rounded-2xl border border-slate-200 shadow-lg flex flex-col overflow-hidden">
            <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrainCircuit size={20} className="text-blue-400" />
                <h3 className="font-bold tracking-tight">Asistente PharmaAI</h3>
              </div>
              <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-1 rounded font-bold uppercase">Sesion Segura</span>
            </div>

            <div className="flex-1 p-6 overflow-y-auto space-y-4 bg-slate-50/30">
              {aiMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] p-4 rounded-xl text-sm leading-relaxed ${
                      msg.role === 'user' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-700 border border-slate-200 shadow-sm'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              {isTyping && (
                <div className="flex justify-start">
                  <div className="bg-white p-4 rounded-xl border border-slate-200">
                    <Loader2 className="animate-spin text-blue-600" size={16} />
                  </div>
                </div>
              )}
            </div>

            <form onSubmit={handleAiChat} className="p-4 bg-white border-t border-slate-200 flex gap-2">
              <input
                name="userInput"
                placeholder="Escriba su consulta clinica o de inventario..."
                className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none"
              />
              <button className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-700 transition-all shadow-sm">
                <Send size={18} />
              </button>
            </form>
          </div>
        )}
      </main>

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
                      : modalType === 'med-edit'
                        ? 'Editar Medicamento'
                        : modalType === 'service-add'
                          ? 'Nuevo Servicio'
                          : modalType === 'pharmacist-add'
                            ? 'Nuevo Farmaceutico'
                            : modalType === 'pharmacist-manage'
                              ? 'Eliminar Farmaceutico'
                              : 'Nuevo Medicamento'}
              </h3>
              <button
                onClick={() => {
                  setShowModal(false);
                  setEditingMedId(null);
                  setEditingTransactionId(null);
                  setEditingExpedienteId(null);
                  setRxTypeValue('CERRADA');
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                x
              </button>
            </div>

            <form onSubmit={modalType === 'pharmacist-manage' ? (e) => e.preventDefault() : handleSave} className="p-8 space-y-4">
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
                    options={medications.map((m) => m.name)}
                    defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.medicamento || medications[0]?.name}
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
                      options={CONDICIONES}
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.condicion || CONDICIONES[0]}
                    />
                    <SelectLabel
                      label="Farmaceutico"
                      name="farmaceutico"
                      options={pharmacists}
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.farmaceutico || pharmacists[0]}
                    />
                  </div>
                </>
              ) : modalType === 'kardex' || modalType === 'kardex-edit' ? (
                <>
                  <SelectLabel
                    label="Medicamento"
                    name="medicationId"
                    options={medications.map((m) => ({ value: m.id, label: m.name }))}
                    isObject
                    defaultValue={transactions.find((t) => t.id === editingTransactionId)?.medId || selectedMedId}
                  />
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
                    <SelectLabel
                      label="Tipo Movimiento"
                      name="type"
                      options={[{ value: 'OUT', label: 'Salida' }, { value: 'IN', label: 'Entrada' }]}
                      isObject
                      defaultValue={transactions.find((t) => t.id === editingTransactionId)?.type || 'OUT'}
                    />
                    <InputLabel
                      label="Cantidad"
                      name="amount"
                      type="number"
                      required
                      defaultValue={transactions.find((t) => t.id === editingTransactionId)?.amount || ''}
                    />
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
              ) : modalType === 'service-add' ? (
                <>
                  <InputLabel label="Nombre del Servicio" name="serviceName" required />
                </>
              ) : modalType === 'pharmacist-add' ? (
                <>
                  <InputLabel label="Nombre del Farmaceutico" name="pharmacistName" required />
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
                </>
              )}
              {modalType !== 'pharmacist-manage' && (
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
