import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  ClipboardList,
  Database,
  FileText,
  Filter,
  History,
  Bell,
  Package,
  PlusCircle,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { auth, db, googleProvider } from './firebase';
import { collection, doc, getCountFromServer, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter, writeBatch, deleteField } from 'firebase/firestore';
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
const PAGE_SIZE = 25;
const CR_TIMEZONE = 'America/Costa_Rica';
const ENV_MAX_RECORDS = Number.parseInt(import.meta.env.VITE_MAX_RECORDS || '', 10);
const DEFAULT_MAX_RECORDS = Number.isFinite(ENV_MAX_RECORDS) && ENV_MAX_RECORDS > 0 ? ENV_MAX_RECORDS : 20000;
const INITIAL_CLOUD_LOAD = 200;
const LOAD_MORE_BATCH_SIZE = 200;
const SOFT_MEMORY_CAP_MULTIPLIER = 5;
const MAX_PENDING_WRITES = 200;
const MAX_SYNC_EVENTS = 200;
const WRITE_BATCH_SIZE = 200;
const BACKUP_SCHEMA_VERSION = 2;
const QUOTA_EXCEEDED_ERRORS = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'];
const INITIAL_MEDICATIONS_BY_ID = new Map(INITIAL_MEDICATIONS.map((m) => [m.id, m]));
const RECOVERABLE_MED_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;
const AUTO_MED_NAME_PATTERN = /^MED\s+\d+$/i;
const INFUSION_DOSE_PATTERN = /INFUSION:\s*([0-9]+(?:\.[0-9]+)?)\s*AMPOLLAS\s*EN\s*([0-9]+(?:\.[0-9]+)?)\s*CC\s*A\s*([0-9]+(?:\.[0-9]+)?)\s*CC\/HR\s*DURACION:\s*([0-9]+(?:\.[0-9]+)?)\s*HRS/i;
const PRIORITY_MEDICATION_ORDER = [
  'MORFINA 15 MG',
  'DIAZEPAM 10 MG',
  'FENTANYL 50 MCG',
  'MIDAZOLAM 15 MG',
  'FENOBARBITAL 50 MG',
  'CLONAZEPAM 2 MG',
  'DIAZEPAM 5 MG',
  'LORAZEPAM 2 MG',
];

const App = () => {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [medications, setMedications] = useState(INITIAL_MEDICATIONS);
  const [selectedMedId, setSelectedMedId] = useState(INITIAL_MEDICATIONS[0].id);
  const [editingMedId, setEditingMedId] = useState(null);
  const [editingTransactionId, setEditingTransactionId] = useState(null);
  const [editingExpedienteId, setEditingExpedienteId] = useState(null);
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
  const [syncEvents, setSyncEvents] = useState([]);
  const [restoreAuditLog, setRestoreAuditLog] = useState([]);
  const [backupAuditLog, setBackupAuditLog] = useState([]);
  const [totalTransactionsCount, setTotalTransactionsCount] = useState(0);
  const [docSyncInFlight, setDocSyncInFlight] = useState(false);
  const [queueOverflow, setQueueOverflow] = useState(false);
  const [writeBlockedByStorage, setWriteBlockedByStorage] = useState(false);
  const [showHistoric, setShowHistoric] = useState(false);
  const [kardexSearch, setKardexSearch] = useState('');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [configMedSearch, setConfigMedSearch] = useState('');
  const [editingConfigMedId, setEditingConfigMedId] = useState(null);
  const [configMedNameDraft, setConfigMedNameDraft] = useState('');
  const [adjustMedId, setAdjustMedId] = useState(INITIAL_MEDICATIONS[0].id);
  const [adjustBalanceValue, setAdjustBalanceValue] = useState('');
  const [adjustPharmacist, setAdjustPharmacist] = useState(INITIAL_PHARMACISTS[0] || '');
  const [maxRecordsLimit, setMaxRecordsLimit] = useState(DEFAULT_MAX_RECORDS);
  const [maxRecordsDraft, setMaxRecordsDraft] = useState(String(DEFAULT_MAX_RECORDS));
  const [kardexRecentPage, setKardexRecentPage] = useState(1);
  const [kardexHistoricPage, setKardexHistoricPage] = useState(1);
  const [auditoriaPage, setAuditoriaPage] = useState(1);
  const [bitacoraPage, setBitacoraPage] = useState(1);
  const [dosisType, setDosisType] = useState('UNICA'); // UNICA | INFUSION
  const [cierreTurnoValue, setCierreTurnoValue] = useState('SEGUNDO');
  const [crossCheckPharmacistValue, setCrossCheckPharmacistValue] = useState(INITIAL_PHARMACISTS[0] || '');
  const [openRxPharmacistValue, setOpenRxPharmacistValue] = useState(INITIAL_PHARMACISTS[0] || '');
  const [openRxAmountValue, setOpenRxAmountValue] = useState('');
  const [repeatConditionValue, setRepeatConditionValue] = useState(INITIAL_CONDICIONES[0] || '');
  const [repeatPharmacistValue, setRepeatPharmacistValue] = useState(INITIAL_PHARMACISTS[0] || '');
  const [securityPromptOpen, setSecurityPromptOpen] = useState(false);
  const [securityPromptValue, setSecurityPromptValue] = useState('');
  const [confirmPromptOpen, setConfirmPromptOpen] = useState(false);
  const [confirmPromptMessage, setConfirmPromptMessage] = useState('');
  const securityPromptResolverRef = useRef(null);
  const confirmPromptResolverRef = useRef(null);
  const [requestQuantities, setRequestQuantities] = useState({});
  const [requestPharmacist, setRequestPharmacist] = useState('');
  const [selectedRequestMeds, setSelectedRequestMeds] = useState({});
  const [pendingOpenRxTransaction, setPendingOpenRxTransaction] = useState(null);
  const [pendingOpenRxAdjustTransaction, setPendingOpenRxAdjustTransaction] = useState(null);
  const [openRxAdjustValue, setOpenRxAdjustValue] = useState('');
  const [openRxAdjustPharmacistValue, setOpenRxAdjustPharmacistValue] = useState(INITIAL_PHARMACISTS[0] || '');
  const [pendingRepeatExpediente, setPendingRepeatExpediente] = useState(null);
  // Data States moved up
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
  const [collectionLoadState, setCollectionLoadState] = useState({
    transactions: { loading: false, hasMore: true },
    expedientes: { loading: false, hasMore: true },
    bitacora: { loading: false, hasMore: true },
  });
  const pendingWritesRef = useRef([]);
  const isFlushingRef = useRef(false);
  const retryTimeoutRef = useRef(null);
  const persistTimeoutRef = useRef(null);
  const retryCountRef = useRef(0);
  const kardexSearchRef = useRef(null);
  const restoreInputRef = useRef(null);
  const lastDocRefs = useRef({
    transactions: null,
    expedientes: null,
    bitacora: null,
  });
  const infiniteSentinelRefs = useRef({
    transactions: null,
    expedientes: null,
    bitacora: null,
  });
  const [auditoriaSearch, setAuditoriaSearch] = useState('');
  const ORG_ID = 'hsvp';
  const dataDocPath = authUser ? `orgData/${ORG_ID}` : `appState/${authUser?.uid || 'anon'}`;

  const toUpper = (value) => (value ? value.toString().toUpperCase().trim() : '');
  const toCatalogId = (value) =>
    toUpper(value)
      .replace(/[\\/]/g, '-')
      .replace(/\s+/g, '_');
  const paginate = (items, page) => {
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const current = Math.min(Math.max(page, 1), totalPages);
    return {
      page: current,
      totalPages,
      items: items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
    };
  };
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
  const parseInfusionDose = (dosis) => {
    const text = (dosis || '').toString();
    const match = text.match(INFUSION_DOSE_PATTERN);
    if (!match) return null;
    return { amps: match[1], vol: match[2], vel: match[3], dur: match[4] };
  };
  const startConfigMedicationEdit = (medication) => {
    setEditingConfigMedId(medication.id);
    setConfigMedNameDraft(medication.name || '');
  };
  const saveConfigMedicationName = () => {
    if (!editingConfigMedId) return;
    const normalizedName = toUpper(configMedNameDraft);
    if (!normalizedName) {
      alert('Ingrese un nombre valido para el medicamento.');
      return;
    }
    setMedications(
      medications.map((m) => (m.id === editingConfigMedId ? { ...m, name: normalizedName } : m)),
    );
    setEditingConfigMedId(null);
    setConfigMedNameDraft('');
  };
  const saveMaxRecordsLimit = async () => {
    const parsed = Number.parseInt(maxRecordsDraft, 10);
    if (!Number.isFinite(parsed) || parsed < 1000) {
      alert('Ingrese un limite valido (minimo 1000).');
      return;
    }
    try {
      await setDoc(doc(db, dataDocPath), { maxRecords: parsed }, { merge: true });
      setMaxRecordsLimit(parsed);
      setCloudStatus('Sincronizado');
      alert('Limite de registros actualizado.');
    } catch {
      setCloudStatus('Sin conexion');
      alert('No se pudo actualizar el limite de registros.');
    }
  };
  const applyManualBalanceAdjustment = () => {
    requestSecurityKey().then((ok) => {
      if (!ok) return;
    const medId = adjustMedId || selectedMedId;
    const amount = parseInt(adjustBalanceValue, 10);
    if (!medId || !Number.isFinite(amount) || amount < 0) {
      alert('Ingrese un saldo valido (entero mayor o igual a 0).');
      return;
    }
    const now = new Date().toLocaleString('es-CR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: CR_TIMEZONE,
    });
    const newAdjustment = {
      id: Date.now(),
      date: now,
      createdAt: Date.now(),
      medId,
      type: 'IN',
      amount: 0,
      service: 'AJUSTE MANUAL DE SALDO',
      cama: '',
      prescription: '',
      rxType: 'CERRADA',
      rxQuantity: 0,
      rxUsed: 0,
      pharmacist: toUpper(adjustPharmacist || pharmacists[0] || ''),
      isCierre: true,
      cierreTurno: 'AJUSTE MANUAL SALDO',
      totalRecetas: 0,
      totalMedicamento: amount,
    };
    setTransactions([newAdjustment, ...transactions]);
    enqueueWrite({ type: 'set', collection: 'transactions', id: newAdjustment.id, data: newAdjustment });
    setAdjustBalanceValue('');
    alert('Ajuste manual de saldo aplicado.');
    });
  };
  const requestSecurityKey = () =>
    new Promise((resolve) => {
      securityPromptResolverRef.current = resolve;
      setSecurityPromptValue('');
      setSecurityPromptOpen(true);
    });
  const resolveSecurityPrompt = (accepted) => {
    const ok = accepted && securityPromptValue === '1984';
    const resolver = securityPromptResolverRef.current;
    securityPromptResolverRef.current = null;
    setSecurityPromptOpen(false);
    setSecurityPromptValue('');
    if (resolver) resolver(ok);
  };
  const requestStyledConfirm = (message) =>
    new Promise((resolve) => {
      confirmPromptResolverRef.current = resolve;
      setConfirmPromptMessage(message || 'Confirme para continuar.');
      setConfirmPromptOpen(true);
    });
  const resolveStyledConfirm = (accepted) => {
    const resolver = confirmPromptResolverRef.current;
    confirmPromptResolverRef.current = null;
    setConfirmPromptOpen(false);
    setConfirmPromptMessage('');
    if (resolver) resolver(Boolean(accepted));
  };
  const downloadDatabaseBackup = () => {
    const summary = {
      medications: medications.length,
      transactions: transactions.length,
      expedientes: expedientes.length,
      bitacora: bitacora.length,
      services: services.length,
      pharmacists: pharmacists.length,
      condiciones: condiciones.length,
    };
    const checksum = btoa(
      unescape(
        encodeURIComponent(
          `${summary.medications}|${summary.transactions}|${summary.expedientes}|${summary.bitacora}|${summary.services}|${summary.pharmacists}|${summary.condiciones}|${selectedMedId}|${maxRecordsLimit}`,
        ),
      ),
    );
    const payload = {
      backupSchemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      orgId: ORG_ID,
      summary,
      checksum,
      data: {
        medications,
        selectedMedId,
        maxRecords: maxRecordsLimit,
        services,
        pharmacists,
        condiciones,
        transactions,
        expedientes,
        bitacora,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `backup_drogas_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setBackupAuditLog((prev) => [
      {
        at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
        fileName: link.download,
        summary,
      },
      ...prev,
    ].slice(0, 20));
  };
  const restoreDatabaseBackup = async (file) => {
    if (!file || !authUser) return;
    setCloudStatus('Restaurando...');
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const backupVersion = Number(parsed?.backupSchemaVersion || 1);
      const data = parsed?.data || parsed || {};
      const incomingMedications = Array.isArray(data.medications) ? data.medications : [];
      const incomingTransactions = Array.isArray(data.transactions) ? data.transactions : [];
      const incomingExpedientes = Array.isArray(data.expedientes) ? data.expedientes : [];
      const incomingBitacora = Array.isArray(data.bitacora) ? data.bitacora : [];
      const incomingServices = Array.isArray(data.services) ? data.services : [];
      const incomingPharmacists = Array.isArray(data.pharmacists) ? data.pharmacists : [];
      const incomingCondiciones = Array.isArray(data.condiciones) ? data.condiciones : [];
      const incomingSelectedMedId =
        typeof data.selectedMedId === 'string' && data.selectedMedId ? data.selectedMedId : incomingMedications[0]?.id;
      const incomingMaxRecords =
        Number.isFinite(data.maxRecords) && data.maxRecords > 0 ? data.maxRecords : maxRecordsLimit;
      const incomingSummary = parsed?.summary || null;
      const expectedChecksum = parsed?.checksum || '';
      const recomputedChecksum = btoa(
        unescape(
          encodeURIComponent(
            `${incomingMedications.length}|${incomingTransactions.length}|${incomingExpedientes.length}|${incomingBitacora.length}|${incomingServices.length}|${incomingPharmacists.length}|${incomingCondiciones.length}|${incomingSelectedMedId || incomingMedications[0]?.id || ''}|${incomingMaxRecords}`,
          ),
        ),
      );
      if (backupVersion < 1 || (expectedChecksum && expectedChecksum !== recomputedChecksum)) {
        alert('El respaldo no paso validacion de integridad (version/checksum).');
        setCloudStatus('Sincronizado');
        return;
      }
      if (incomingMedications.length === 0) {
        alert('El archivo no contiene medicamentos validos para restaurar.');
        setCloudStatus('Sincronizado');
        return;
      }
      const confirmed = window.confirm(
        'Esto reemplazara por completo la base actual en Firebase con los datos del archivo. ¿Desea continuar?',
      );
      if (!confirmed) {
        setCloudStatus('Sincronizado');
        return;
      }

      const chunk = (items, size = 450) => {
        const groups = [];
        for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
        return groups;
      };
      const batchDeleteByList = async (collectionName, items) => {
        for (const group of chunk(items)) {
          const batch = writeBatch(db);
          group.forEach((item) => batch.delete(doc(db, dataDocPath, collectionName, String(item.id))));
          await batch.commit();
        }
      };
      const batchSetByList = async (collectionName, items) => {
        for (const group of chunk(items)) {
          const batch = writeBatch(db);
          group.forEach((item) => batch.set(doc(db, dataDocPath, collectionName, String(item.id)), item, { merge: true }));
          await batch.commit();
        }
      };
      const batchReplaceCatalog = async (collectionName, currentList, incomingList) => {
        const deleteBatch = writeBatch(db);
        currentList.forEach((name) => deleteBatch.delete(doc(db, dataDocPath, collectionName, toCatalogId(name))));
        await deleteBatch.commit();
        for (const group of chunk(incomingList)) {
          const batch = writeBatch(db);
          group.forEach((name) => {
            const normalized = toUpper(name);
            const id = toCatalogId(normalized);
            batch.set(doc(db, dataDocPath, collectionName, id), { id, name: normalized, createdAt: Date.now() }, { merge: true });
          });
          await batch.commit();
        }
      };

      await batchDeleteByList('transactions', transactions);
      await batchDeleteByList('expedientes', expedientes);
      await batchDeleteByList('bitacora', bitacora);
      await batchSetByList('transactions', incomingTransactions);
      await batchSetByList('expedientes', incomingExpedientes);
      await batchSetByList('bitacora', incomingBitacora);
      await batchReplaceCatalog('catalog_services', services, incomingServices);
      await batchReplaceCatalog('catalog_pharmacists', pharmacists, incomingPharmacists);
      await batchReplaceCatalog('catalog_condiciones', condiciones, incomingCondiciones);
      await setDoc(
        doc(db, dataDocPath),
        {
          medications: incomingMedications,
          selectedMedId: incomingSelectedMedId || incomingMedications[0].id,
          maxRecords: incomingMaxRecords,
        },
        { merge: true },
      );

      pendingWritesRef.current = [];
      setPendingCount(0);
      setQueueOverflow(false);
      localStorage.removeItem('pharmaPendingWrites');
      localStorage.removeItem('pharmaControlData');
      setMedications(incomingMedications);
      setSelectedMedId(incomingSelectedMedId || incomingMedications[0].id);
      setMaxRecordsLimit(incomingMaxRecords);
      setMaxRecordsDraft(String(incomingMaxRecords));
      setServices(incomingServices);
      setPharmacists(incomingPharmacists);
      setCondiciones(incomingCondiciones);
      setTransactions(incomingTransactions);
      setExpedientes(incomingExpedientes);
      setBitacora(incomingBitacora);
      setCloudStatus('Sincronizado');
      setRestoreAuditLog((prev) => [
        {
          at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
          fileName: file.name,
          backupVersion,
          summary: incomingSummary || {
            medications: incomingMedications.length,
            transactions: incomingTransactions.length,
            expedientes: incomingExpedientes.length,
            bitacora: incomingBitacora.length,
          },
        },
        ...prev,
      ].slice(0, 20));
      alert('Restauracion completada.');
    } catch (error) {
      console.error(error);
      setCloudStatus('Sin conexion');
      alert('No se pudo restaurar el archivo JSON.');
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = '';
    }
  };

  const getRxProgress = (t) => {
    if (t.rxType !== 'ABIERTA') return '';
    const used = Number(t.rxUsed) || 0;
    return `${used} de ${t.rxQuantity}`;
  };

  const nextOpenRxUse = (items, medId, prescription, rxQuantity) => {
    const matches = items.filter(
      (t) => t.medId === medId && t.rxType === 'ABIERTA' && t.prescription === prescription && t.rxQuantity === rxQuantity,
    );
    if (matches.length === 0) return 1;
    const maxUsed = Math.max(...matches.map((t) => t.rxUsed || 0));
    return Math.min(maxUsed + 1, rxQuantity);
  };
  const getCurrentOpenRxAmount = (items, transaction) => {
    const matches = items
      .filter(
        (t) =>
          t.medId === transaction.medId &&
          t.prescription === transaction.prescription &&
          t.type === 'OUT' &&
          t.rxType === 'ABIERTA' &&
          t.rxQuantity === transaction.rxQuantity,
      )
      .sort(compareTransactionsDesc);
    const latest = matches[0];
    return Number.isFinite(Number(latest?.amount)) ? Number(latest.amount) : Number(transaction.amount) || 0;
  };

  const parseDateTime = (value) => {
    if (!value) return null;
    const cleaned = value
      .replace(',', '')
      .replace(/\s*a\.\s*m\.\s*$/i, ' AM')
      .replace(/\s*p\.\s*m\.\s*$/i, ' PM')
      .trim();
    const parts = cleaned.split(/\s+/);
    const datePart = parts[0];
    const timePart = parts[1] || '';
    const ampm = (parts[2] || '').toUpperCase();
    if (!datePart) return null;
    const [day, month, year] = datePart.split('/').map(Number);
    if (!day || !month || !year) return null;
    let [hour = 0, minute = 0] = (timePart || '').split(':').map(Number);
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return new Date(year, month - 1, day, hour, minute);
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getTransactionTimestamp = (t) => {
    const fromDate = parseDateTime(t?.date)?.getTime();
    if (Number.isFinite(fromDate)) return fromDate;
    if (Number.isFinite(t?.createdAt)) return t.createdAt;
    return 0;
  };
  const compareTransactionsAsc = (a, b) => {
    const aDate = getTransactionTimestamp(a);
    const bDate = getTransactionTimestamp(b);
    if (aDate !== bDate) return aDate - bDate;
    const aCreated = Number.isFinite(a?.createdAt) ? a.createdAt : 0;
    const bCreated = Number.isFinite(b?.createdAt) ? b.createdAt : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    const aId = Number(a?.id) || 0;
    const bId = Number(b?.id) || 0;
    return aId - bId;
  };
  const compareTransactionsDesc = (a, b) => compareTransactionsAsc(b, a);
  const getLastBalanceAnchor = (items, medId) =>
    items
      .filter(
        (t) =>
          t.medId === medId &&
          t.isCierre &&
          (t.cierreTurno === 'CIERRE 24 HORAS' || t.cierreTurno === 'AJUSTE MANUAL SALDO'),
      )
      .sort(compareTransactionsDesc)[0];
  const isQuotaExceededError = (error) =>
    error &&
    (QUOTA_EXCEEDED_ERRORS.includes(error.name) ||
      error.code === 22 ||
      error.code === 1014 ||
      /quota/i.test(error.message || ''));
  const safeSetLocalStorage = (key, value) => {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      if (!isQuotaExceededError(error)) return false;
      try {
        localStorage.removeItem(key);
      } catch {
        // Ignorar errores de limpieza.
      }
      if (key === 'pharmaPendingWrites') {
        setQueueOverflow(true);
        setWriteBlockedByStorage(true);
        setSyncError('Cola offline sin espacio: nuevas escrituras bloqueadas hasta sincronizar/liberar espacio.');
        setSyncEvents((prev) => [
          {
            at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
            type: 'blocked_by_quota',
            detail: 'Sin espacio en almacenamiento local para cola offline.',
          },
          ...prev,
        ].slice(0, MAX_SYNC_EVENTS));
      }
      return false;
    }
  };
  const logSyncEvent = (type, detail) => {
    setSyncEvents((prev) => [
      {
        at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
        type,
        detail,
      },
      ...prev,
    ].slice(0, MAX_SYNC_EVENTS));
  };
  const persistPendingWrites = (items) => {
    // Keep the newest actions so recent deletes/edits are not dropped.
    const capped = items.slice(-MAX_PENDING_WRITES);
    setQueueOverflow(items.length > MAX_PENDING_WRITES);
    const persisted = safeSetLocalStorage('pharmaPendingWrites', JSON.stringify(capped));
    if (!persisted) return false;
    pendingWritesRef.current = capped;
    setPendingCount((pendingWritesRef.current || []).length);
    return true;
  };

  const handleOpenRxUse = (transaction, overridePharmacist, overrideAmount) => {
    if (transaction.rxType !== 'ABIERTA' || transaction.rxQuantity <= 0) return;
    const nextUsed = nextOpenRxUse(transactions, transaction.medId, transaction.prescription, transaction.rxQuantity);
    if (nextUsed <= transaction.rxUsed) return;
    const amountToUse = parseInt(overrideAmount, 10);
    if (!Number.isFinite(amountToUse) || amountToUse <= 0) return;
    const now = new Date().toLocaleString('es-CR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: CR_TIMEZONE,
    });
    const newTransaction = {
      ...transaction,
      id: Date.now(),
      date: now,
      createdAt: Date.now(),
      type: 'OUT',
      amount: amountToUse,
      rxUsed: nextUsed,
      pharmacist: toUpper(overridePharmacist || transaction.pharmacist),
    };
    setTransactions([newTransaction, ...transactions]);
    enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
  };

  const enqueueWrite = (action) => {
    if (writeBlockedByStorage) {
      setSyncError('Escritura bloqueada: libere espacio local o sincronice pendientes.');
      logSyncEvent('enqueue_blocked', `${action.collection}/${action.id}`);
      return;
    }
    const enriched = { ...action, opId: action.opId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
    const next = [...(pendingWritesRef.current || []), enriched];
    const deduped = [];
    const seenOpIds = new Set();
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const item = next[i];
      if (seenOpIds.has(item.opId)) continue;
      seenOpIds.add(item.opId);
      deduped.push(item);
    }
    deduped.reverse();
    const ok = persistPendingWrites(deduped);
    if (!ok) return;
    logSyncEvent('enqueue', `${enriched.type} ${enriched.collection}/${enriched.id}`);
    if (!authUser) return;
    flushWriteQueue();
  };

  const flushWriteQueue = async () => {
    if (isFlushingRef.current || !authUser) return;
    const queue = pendingWritesRef.current || [];
    if (queue.length === 0) return;
    isFlushingRef.current = true;
    setCloudStatus('Sincronizando...');
    logSyncEvent('flush_start', `items=${queue.length}`);
    try {
      const remaining = [];
      const errors = [];
      const chunks = [];
      for (let i = 0; i < queue.length; i += WRITE_BATCH_SIZE) chunks.push(queue.slice(i, i + WRITE_BATCH_SIZE));
      for (const group of chunks) {
        try {
          const batch = writeBatch(db);
          group.forEach((action) => {
            const ref = doc(db, dataDocPath, action.collection, String(action.id));
            if (action.type === 'set') batch.set(ref, action.data, { merge: true });
            else if (action.type === 'delete') batch.delete(ref);
          });
          await batch.commit();
        } catch (error) {
          group.forEach((action) => {
            remaining.push(action);
            errors.push({
              id: action.id,
              collection: action.collection,
              type: action.type,
              code: error?.code || 'unknown',
              message: error?.message || 'No error message',
              time: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
            });
          });
        }
      }
      const persisted = persistPendingWrites(remaining);
      if (!persisted) {
        setCloudStatus('Sin conexion');
        setSyncError('No se pudo persistir la cola local de pendientes. Libere espacio y reintente.');
        logSyncEvent('flush_error', 'Persistencia local de cola fallida');
        return;
      }
      if (remaining.length === 0) {
        localStorage.removeItem('pharmaPendingWrites');
        localStorage.removeItem('pharmaControlData');
        setCloudStatus('Sincronizado');
        setSyncError('');
        setWriteBlockedByStorage(false);
        retryCountRef.current = 0;
        setSyncErrors([]);
        setQueueOverflow(false);
        logSyncEvent('flush_ok', `items=${queue.length}`);
      } else {
        setCloudStatus('Sin conexion');
        setSyncError('Algunos registros no pudieron sincronizarse.');
        setSyncErrors((prev) => [...errors, ...prev].slice(0, 50));
        if (!retryTimeoutRef.current) {
          const baseDelay = Math.min(30000, 2000 * Math.pow(2, retryCountRef.current));
          const jitter = Math.floor(Math.random() * 600);
          const delayMs = baseDelay + jitter;
          logSyncEvent('retry_scheduled', `remaining=${remaining.length} delayMs=${delayMs}`);
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            retryCountRef.current += 1;
            flushWriteQueue();
          }, delayMs);
        }
      }
    } catch {
      setCloudStatus('Sin conexion');
      logSyncEvent('flush_error', 'Error general en flush');
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
        setMaxRecordsLimit(DEFAULT_MAX_RECORDS);
        setMaxRecordsDraft(String(DEFAULT_MAX_RECORDS));
        setPendingCount(0);
        setSyncErrors([]);
        setQueueOverflow(false);
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
        setQueueOverflow(stored.length > MAX_PENDING_WRITES);
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
    if (!authUser || !cloudReady) return;
    const loadTotalTransactionsCount = async () => {
      try {
        const colRef = collection(db, dataDocPath, 'transactions');
        const snap = await getCountFromServer(colRef);
        setTotalTransactionsCount(Number(snap.data()?.count || 0));
      } catch {
        setTotalTransactionsCount((prev) => (prev > 0 ? prev : transactions.length));
      }
    };
    loadTotalTransactionsCount();
  }, [authUser, cloudReady, dataDocPath, pendingCount, transactions.length]);

  useEffect(() => {
    if (!showModal) {
      setCatalogSearch('');
    }
  }, [showModal]);

  useEffect(() => {
    setKardexRecentPage(1);
    setKardexHistoricPage(1);
  }, [selectedMedId, kardexSearch]);

  useEffect(() => {
    const handleShortcuts = (event) => {
      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        if (showModal) return;
        event.preventDefault();
        setIsQuickIngreso(false);
        setModalType(activeTab === 'auditoria' ? 'auditoria' : activeTab === 'bitacora' ? 'bitacora' : 'kardex');
        setShowModal(true);
      }
      if (key === 'f' && activeTab === 'kardex') {
        event.preventDefault();
        kardexSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [activeTab, showModal]);

  useEffect(() => {
    if (!authUser) return;
    let cancelled = false;
    const hydrateFromCloud = async () => {
      setCloudLoading(true);
      setCloudStatus('Sincronizando...');
      let hadPartial = false;
      let hadLoadError = false;
      try {
        const ref = doc(db, dataDocPath);
        const snap = await getDoc(ref);
        let loadedMedications = [...INITIAL_MEDICATIONS];
        let legacyServices = null;
        let legacyPharmacists = null;
        let legacyCondiciones = null;
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          if (data.medications?.length) {
            loadedMedications = data.medications;
            setMedications(data.medications);
          }
          if (Number.isFinite(data.maxRecords) && data.maxRecords > 0) {
            setMaxRecordsLimit(data.maxRecords);
            setMaxRecordsDraft(String(data.maxRecords));
          }
          if (data.services?.length) legacyServices = data.services;
          if (data.pharmacists?.length) legacyPharmacists = data.pharmacists;
          if (data.condiciones?.length) legacyCondiciones = data.condiciones;
          if (data.selectedMedId) setSelectedMedId(data.selectedMedId);
          if (data.transactions?.length || data.expedientes?.length || data.bitacora?.length) {
            const batch = writeBatch(db);
            data.transactions?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.date)?.getTime() ?? Date.now();
              batch.set(doc(db, dataDocPath, 'transactions', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            data.expedientes?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.fecha)?.getTime() ?? Date.now();
              batch.set(doc(db, dataDocPath, 'expedientes', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            data.bitacora?.forEach((item) => {
              const createdAt = item.createdAt ?? parseDateTime(item.fecha)?.getTime() ?? Date.now();
              batch.set(doc(db, dataDocPath, 'bitacora', String(item.id)), { ...item, createdAt }, { merge: true });
            });
            await batch.commit();
            await setDoc(
              ref,
              { transactions: deleteField(), expedientes: deleteField(), bitacora: deleteField() },
              { merge: true },
            );
          }
        }

        const loadCatalogCollection = async (name, setter, legacyList) => {
          const colRef = collection(db, dataDocPath, name);
          const snap = await getDocs(colRef);
          if (snap.empty) {
            if (legacyList?.length) {
              const batch = writeBatch(db);
              legacyList.forEach((item) => {
                const normalized = toUpper(item);
                if (!normalized) return;
                const id = toCatalogId(normalized);
                batch.set(
                  doc(db, dataDocPath, name, id),
                  { id, name: normalized, createdAt: Date.now() },
                  { merge: true },
                );
              });
              await batch.commit();
              setter(
                legacyList
                  .map((item) => toUpper(item))
                  .filter(Boolean)
                  .sort((a, b) => a.localeCompare(b, 'es')),
              );
              return true;
            }
            return false;
          }
          const items = snap.docs
            .map((docSnap) => docSnap.data().name || docSnap.id)
            .map((item) => toUpper(item))
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'es'));
          setter(items);
          return false;
        };

        const loadCollection = async (name, setter) => {
          const colRef = collection(db, dataDocPath, name);
          const initialLoadLimit = Math.max(25, Math.min(maxRecordsLimit, INITIAL_CLOUD_LOAD));
          const items = [];
          let lastDoc = null;
          let indexError = false;
          let hadError = false;
          while (items.length < initialLoadLimit) {
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
              indexError = true;
              hadError = true;
              break;
            }
          }
          lastDocRefs.current[name] = lastDoc;
          setCollectionLoadState((prev) => ({
            ...prev,
            [name]: { ...prev[name], hasMore: items.length >= initialLoadLimit },
          }));
          setter(items.slice(0, initialLoadLimit));
          return { items, indexError, hadError };
        };
        const [transactionsLoaded, expedientesLoaded, bitacoraLoaded] = await Promise.all([
          loadCollection('transactions', setTransactions),
          loadCollection('expedientes', setExpedientes),
          loadCollection('bitacora', setBitacora),
        ]);
        const [servicesMigrated, pharmacistsMigrated, condicionesMigrated] = await Promise.all([
          loadCatalogCollection('catalog_services', setServices, legacyServices),
          loadCatalogCollection('catalog_pharmacists', setPharmacists, legacyPharmacists),
          loadCatalogCollection('catalog_condiciones', setCondiciones, legacyCondiciones),
        ]);
        const knownMedIds = new Set(loadedMedications.map((m) => m.id));
        const missingMedIds = Array.from(
          new Set(
            transactionsLoaded.items
              .map((t) => t.medId)
              .filter((id) => id && !knownMedIds.has(id)),
          ),
        );
        if (missingMedIds.length > 0) {
          const recovered = missingMedIds
            .filter((id) => INITIAL_MEDICATIONS_BY_ID.has(id) || RECOVERABLE_MED_ID_PATTERN.test(id))
            .map((id) => {
            const base = INITIAL_MEDICATIONS_BY_ID.get(id);
            if (base) return base;
            return {
              id,
              name: toUpper(id.replace(/[-_]/g, ' ')),
              type: 'Otros',
              unitPrice: 0,
              quota: 0,
            };
            });
          if (recovered.length > 0) {
            loadedMedications = [...loadedMedications, ...recovered];
            setMedications(loadedMedications);
          }
        }
        if (servicesMigrated || pharmacistsMigrated || condicionesMigrated) {
          await setDoc(
            ref,
            { services: deleteField(), pharmacists: deleteField(), condiciones: deleteField() },
            { merge: true },
          );
        }
        const anyIndexError =
          transactionsLoaded.indexError || expedientesLoaded.indexError || bitacoraLoaded.indexError;
        const anyError = transactionsLoaded.hadError || expedientesLoaded.hadError || bitacoraLoaded.hadError;
        hadPartial = anyIndexError || anyError;
        hadLoadError = anyError;
        if (anyIndexError) {
          setCloudStatus('Sin conexion');
          setSyncError('Error de indice/consulta en Firestore (createdAt). Revise indices de colecciones.');
        } else if (anyError) {
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
          if (Number.isFinite(stored.maxRecords) && stored.maxRecords > 0) {
            setMaxRecordsLimit(stored.maxRecords);
            setMaxRecordsDraft(String(stored.maxRecords));
          }
          if (stored.bitacora?.length) setBitacora(stored.bitacora);
        } catch {
          localStorage.removeItem('pharmaControlData');
        }
      } finally {
        if (!cancelled) {
          setCloudReady(true);
          if (syncError || hadLoadError) setCloudStatus('Sin conexion');
          else if (hadPartial) setCloudStatus('Carga parcial');
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

  const loadMoreCollection = async (name, setter) => {
    if (!authUser || !cloudReady) return;
    if (collectionLoadState[name]?.loading || !collectionLoadState[name]?.hasMore) return;
    setCollectionLoadState((prev) => ({ ...prev, [name]: { ...prev[name], loading: true } }));
    try {
      const colRef = collection(db, dataDocPath, name);
      const lastDoc = lastDocRefs.current[name];
      const q = lastDoc
        ? query(colRef, orderBy('createdAt', 'desc'), startAfter(lastDoc), limit(LOAD_MORE_BATCH_SIZE))
        : query(colRef, orderBy('createdAt', 'desc'), limit(LOAD_MORE_BATCH_SIZE));
      const snap = await getDocs(q);
      if (!snap || snap.empty) {
        setCollectionLoadState((prev) => ({ ...prev, [name]: { loading: false, hasMore: false } }));
        return;
      }
      const batchItems = snap.docs.map((d) => d.data());
      lastDocRefs.current[name] = snap.docs[snap.docs.length - 1];
      setter((prev) => {
        const seen = new Set(prev.map((item) => String(item.id)));
        const merged = [...prev, ...batchItems.filter((item) => !seen.has(String(item.id)))];
        const softCap = Math.max(maxRecordsLimit, maxRecordsLimit * SOFT_MEMORY_CAP_MULTIPLIER);
        if (merged.length <= softCap) return merged;
        return merged
          .slice()
          .sort((a, b) => {
            const aTime = a.createdAt ?? parseDateTime(a.date || a.fecha)?.getTime() ?? 0;
            const bTime = b.createdAt ?? parseDateTime(b.date || b.fecha)?.getTime() ?? 0;
            return bTime - aTime;
          })
          .slice(0, softCap);
      });
      const reachedEnd = snap.docs.length < LOAD_MORE_BATCH_SIZE;
      setCollectionLoadState((prev) => ({
        ...prev,
        [name]: { loading: false, hasMore: !reachedEnd },
      }));
    } catch {
      setSyncError('No se pudo cargar mas datos: falta indice createdAt o hay error de conexion.');
      setCollectionLoadState((prev) => ({ ...prev, [name]: { ...prev[name], loading: false } }));
    }
  };

  useEffect(() => {
    if (!authUser || !cloudReady) return;
    if (!kardexSearch.trim()) return;
    if (!collectionLoadState.transactions.hasMore || collectionLoadState.transactions.loading) return;
    loadMoreCollection('transactions', setTransactions);
  }, [
    authUser,
    cloudReady,
    kardexSearch,
    collectionLoadState.transactions.hasMore,
    collectionLoadState.transactions.loading,
  ]);

  useEffect(() => {
    if (!authUser || !cloudReady) return;
    const map = {
      kardex: { name: 'transactions', setter: setTransactions },
      auditoria: { name: 'expedientes', setter: setExpedientes },
      bitacora: { name: 'bitacora', setter: setBitacora },
    };
    const config = map[activeTab];
    if (!config) return;
    const target = infiniteSentinelRefs.current[config.name];
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) return;
        loadMoreCollection(config.name, config.setter);
      },
      { root: null, rootMargin: '200px 0px', threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeTab, authUser, cloudReady, collectionLoadState]);

  useEffect(() => {
    if (!authUser || !cloudReady) return;
    const map = {
      kardex: { name: 'transactions', setter: setTransactions },
      auditoria: { name: 'expedientes', setter: setExpedientes },
      bitacora: { name: 'bitacora', setter: setBitacora },
    };
    const config = map[activeTab];
    if (!config) return;
    const handleScroll = () => {
      const status = collectionLoadState[config.name];
      if (!status?.hasMore || status?.loading) return;
      const viewportBottom = window.scrollY + window.innerHeight;
      const pageBottom = document.documentElement.scrollHeight;
      if (pageBottom - viewportBottom < 260) {
        loadMoreCollection(config.name, config.setter);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    handleScroll();
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [activeTab, authUser, cloudReady, collectionLoadState]);

  const handleRequestChange = (medId, value) => {
    const num = parseInt(value, 10);
    setRequestQuantities((prev) => ({
      ...prev,
      [medId]: isNaN(num) || num < 0 ? 0 : num,
    }));
  };

  const toggleRequestMed = (medId) => {
    const med = requestInventory.find((item) => item.id === medId);
    const defaultQty = Number(med?.totalReponer) || 0;
    setSelectedRequestMeds((prev) => {
      const nextSelected = !prev[medId];
      if (nextSelected) {
        setRequestQuantities((prevQty) => {
          if (prevQty[medId] !== undefined) return prevQty;
          return {
            ...prevQty,
            [medId]: defaultQty,
          };
        });
      }
      return {
        ...prev,
        [medId]: nextSelected,
      };
    });
  };

  const generateRequestPDF = async () => {
    if (!requestPharmacist) {
      alert('Por favor seleccione el farmaceutico que elabora la solicitud.');
      return;
    }

    const priorityMedicationNames = PRIORITY_MEDICATION_ORDER.slice(0, 8);
    const medByName = new Map(requestInventory.map((med) => [toUpper(med.name), med]));
    const prioritizedItems = priorityMedicationNames
      .map((name) => medByName.get(toUpper(name)))
      .filter(Boolean)
      .map((med) => ({
        name: med.name,
        stock: med.stock,
        qty: requestQuantities[med.id] || 0,
      }));
    const selectedItems = requestInventory
      .filter((med) => selectedRequestMeds[med.id] && (requestQuantities[med.id] || 0) > 0)
      .map((med) => ({
        name: med.name,
        stock: med.stock,
        qty: requestQuantities[med.id],
      }));
    const seenNames = new Set(prioritizedItems.map((item) => toUpper(item.name)));
    const extraItems = selectedItems.filter((item) => !seenNames.has(toUpper(item.name)));
    const itemsToRequest = [...prioritizedItems, ...extraItems];

    if (itemsToRequest.length === 0) {
      alert('Por favor seleccione al menos un medicamento e ingrese una cantidad mayor a 0.');
      return;
    }

    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const doc = new jsPDF();
    const now = new Date().toLocaleString('es-CR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: CR_TIMEZONE,
    });

    // Header
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('HOSPITAL SAN VICENTE DE PAUL', 105, 15, { align: 'center' });
    doc.setFontSize(12);
    doc.text('CONTROL DE DROGAS Y ESTUPEFACIENTES', 105, 22, { align: 'center' });
    doc.setFontSize(14);
    doc.text('SOLICITUD DE REPOSICION DE STOCK', 105, 32, { align: 'center' });

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Fecha y Hora: ${now}`, 14, 42);
    doc.text(`Solicitante: ${authUser?.email || 'N/A'}`, 14, 48);
    doc.text(`Elaborado por: ${requestPharmacist}`, 14, 54);

    // Table
    autoTable(doc, {
      startY: 60,
      head: [['Medicamento', 'Cantidad Actual', 'Cantidad Solicitada']],
      body: itemsToRequest.map((item) => [item.name, item.stock, item.qty]),
      theme: 'grid',
      headStyles: { fillColor: [22, 163, 74], halign: 'center', valign: 'middle' }, // Emerald-600 like
      styles: { fontSize: 10, cellPadding: 3 },
      columnStyles: {
        1: { halign: 'center' },
        2: { halign: 'center' },
      },
    });

    // Signatures
    const finalY = doc.lastAutoTable.finalY + 40;

    doc.line(20, finalY, 80, finalY);
    doc.text('Firma Solicitante', 50, finalY + 5, { align: 'center' });

    doc.line(130, finalY, 190, finalY);
    doc.text('Firma Recibido (Farmacia)', 160, finalY + 5, { align: 'center' });

    doc.save(`solicitud_reposicion_${Date.now()}.pdf`);
  };

  // Data States moved to top

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
      maxRecords: maxRecordsLimit,
    };
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      safeSetLocalStorage('pharmaControlData', JSON.stringify(localPayload));
    }, 700);
    if (!cloudReady || !authUser) return;
    if (pendingWritesRef.current.length > 0 || isFlushingRef.current) return;
    const cloudPayload = {
      medications,
      selectedMedId,
      maxRecords: maxRecordsLimit,
    };
    setDocSyncInFlight(true);
    setCloudStatus('Sincronizando...');
    setDoc(doc(db, dataDocPath), cloudPayload, { merge: true })
      .then(() => {
        if ((pendingWritesRef.current || []).length === 0 && !isFlushingRef.current && !syncError) {
          setCloudStatus('Sincronizado');
        }
      })
      .catch((error) => {
        setCloudStatus('Sin conexion');
        setSyncError('No se pudo sincronizar configuracion general.');
        setSyncErrors((prev) => [
          {
            id: 'root-doc',
            collection: dataDocPath,
            type: 'set',
            code: error?.code || 'unknown',
            message: error?.message || 'No error message',
            time: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
          },
          ...prev,
        ].slice(0, 50));
      })
      .finally(() => setDocSyncInFlight(false));
  }, [medications, selectedMedId, maxRecordsLimit, cloudReady, authUser, syncError]);

  useEffect(() => () => {
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!authUser) return;
    if (syncError) {
      setCloudStatus('Sin conexion');
      return;
    }
    if ((pendingWritesRef.current || []).length > 0 || isFlushingRef.current || docSyncInFlight || cloudLoading) {
      setCloudStatus('Sincronizando...');
      return;
    }
    setCloudStatus('Sincronizado');
  }, [authUser, syncError, pendingCount, docSyncInFlight, cloudLoading]);

  const handleRollover = async () => {
    if (!window.confirm('Se ha alcanzado el limite de seguridad de registros. El sistema debe realizar un cierre de periodo automatico.\n\nEsto descargara un respaldo, limpiara el historial y mantendra los saldos actuales.\n\n¿Desea proceder?')) {
      return;
    }

    setCloudStatus('Realizando Cierre...');

    try {
      // 1. Backup Data
      const backupData = {
        date: new Date().toISOString(),
        transactions,
        expedientes,
        bitacora,
        medications,
        services,
        pharmacists,
        condiciones
      };

      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `backup_farmacia_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 2. Calculate Carry-Over Stocks
      const carryOverTransactions = sortedMedications.map(med => {
        const medTransactions = transactions.filter((t) => t.medId === med.id && !t.isCierre);
        const stock = medTransactions.reduce((acc, t) => (t.type === 'IN' ? acc + t.amount : acc - t.amount), 0);

        if (stock <= 0) return null;

        return {
          id: Date.now() + Math.random(),
          date: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
          createdAt: Date.now(),
          medId: med.id,
          type: 'IN',
          amount: stock,
          service: 'SALDO INICIAL',
          cama: '',
          prescription: 'Cierre Periodo',
          rxType: 'CERRADA',
          rxQuantity: 0,
          rxUsed: 0,
          pharmacist: 'SISTEMA',
        };
      }).filter(Boolean);

      // 3. Wipe & Batch Initialize
      // We'll trust the sync queue to handle the cloud deletes if we just clear local state 
      // BUT for safety/speed with big data, we might want to let the user know this is happening.
      // Since our sync relies on pendingWrites, deleting 5000 items one by one is too heavy.
      // A better approach for the cloud is to rely on the fact that we can just start fresh collections or
      // let the user know. 
      // However, to keep it simple with existing architecture:
      // We will clear the local arrays and enqueue "set" for the new ones.
      // Deleting 5000 docs via the queue might be slow. 
      // Ideally, we'd use a cloud function, but we don't have one.
      // So we will just RESET the local state and let the new "startup" be fresh.
      // The old data remains in Firebase until manually cleaned or we implement a background cleaner.
      // OR specifically for this app, we can just "forget" the old data by updating the state.
      // IF we want to strictly delete from Firebase:
      // We would need to batch delete. Let's try to batch delete top 500 recently loaded to be safe, 
      // or just assume the backup is enough and we are "moving forward".

      // DECISION: To avoid saturation, we MUST delete from Firebase.
      // We will delete the collections using batching here directly.

      const batchDelete = async (collectionName, items) => {
        const chunks = [];
        for (let i = 0; i < items.length; i += 500) {
          chunks.push(items.slice(i, i + 500));
        }

        for (const chunk of chunks) {
          const batch = writeBatch(db);
          chunk.forEach(item => {
            batch.delete(doc(db, dataDocPath, collectionName, String(item.id)));
          });
          await batch.commit();
        }
      };

      await batchDelete('transactions', transactions);
      await batchDelete('expedientes', expedientes);
      await batchDelete('bitacora', bitacora);

      // 4. Set New State
      setTransactions(carryOverTransactions);
      setExpedientes([]);
      setBitacora([]);

      // 5. Sync New Balances
      carryOverTransactions.forEach(t => {
        enqueueWrite({ type: 'set', collection: 'transactions', id: t.id, data: t });
      });

      alert('Cierre de periodo completado exitosamente. El sistema se ha reiniciado con los saldos actuales.');
      window.location.reload(); // Reload to ensure clean state

    } catch (error) {
      console.error(error);
      alert('Error durante el cierre de periodo. Por favor revise la consola y reporte al administrador.');
    } finally {
      setCloudStatus('Sincronizado');
    }
  };

  useEffect(() => {
    if (transactions.length >= maxRecordsLimit && cloudReady && authUser) {
      // Add a small delay/debounce to avoid immediate trigger on load if just over limit
      const timer = setTimeout(() => {
        handleRollover();
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [transactions.length, cloudReady, authUser, maxRecordsLimit]);

  // Computations
  const sortedMedications = useMemo(() => {
    const priorityIndex = new Map(PRIORITY_MEDICATION_ORDER.map((name, index) => [name, index]));
    return [...medications].sort((a, b) => {
      const aName = toUpper(a.name);
      const bName = toUpper(b.name);
      const aPriority = priorityIndex.has(aName) ? priorityIndex.get(aName) : Number.POSITIVE_INFINITY;
      const bPriority = priorityIndex.has(bName) ? priorityIndex.get(bName) : Number.POSITIVE_INFINITY;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return aName.localeCompare(bName, 'es');
    });
  }, [medications]);

  const currentInventory = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    return sortedMedications.map((med) => {
      const lastAnchor = getLastBalanceAnchor(transactions, med.id);
      const closeTime = lastAnchor ? getTransactionTimestamp(lastAnchor) : null;
      const baseStock = Number(lastAnchor?.totalMedicamento) || 0;
      const periodTransactions = transactions.filter(
        (t) =>
          t.medId === med.id &&
          !t.isCierre &&
          (closeTime === null || getTransactionTimestamp(t) > closeTime),
      );
      const stock = periodTransactions.reduce((acc, t) => (t.type === 'IN' ? acc + t.amount : acc - t.amount), baseStock);
      const weeklyOut = periodTransactions.reduce((acc, t) => {
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

  const kpiStats = useMemo(() => {
    // 1. Service Consumption (Top 5)
    const serviceConsumption = {};
    transactions.forEach((t) => {
      if (t.type === 'OUT' && t.service) {
        serviceConsumption[t.service] = (serviceConsumption[t.service] || 0) + t.amount;
      }
    });
    const topServices = Object.entries(serviceConsumption)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));

    // 2. Intervention Rate
    const totalExp = expedientes.length;
    const issues = expedientes.filter((e) => ['INCONSISTENTE', 'SUSPENDIDA'].includes(e.condicion)).length;
    const interventionRate = totalExp > 0 ? Math.round((issues / totalExp) * 100) : 0;

    // 3. Daily Consumption Trend (Last 7 Days)
    const today = new Date();
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      trend.push({
        date: d,
        day: d.toLocaleDateString('es-CR', { weekday: 'short', timeZone: CR_TIMEZONE }).slice(0, 3).toUpperCase(),
        value: 0
      });
    }

    transactions.forEach((t) => {
      if (t.type !== 'OUT') return;
      const tDate = t.createdAt ? new Date(t.createdAt) : parseDateTime(t.date);
      if (!tDate) return;
      const entry = trend.find((d) => d.date.toDateString() === tDate.toDateString());
      if (entry) entry.value += t.amount;
    });

    const totalTrend = trend.reduce((acc, curr) => acc + curr.value, 0);

    return { topServices, interventionRate, trend, totalTrend };
  }, [transactions, expedientes]);

  const sortedExpedientes = useMemo(() => {
    return [...expedientes].sort((a, b) => {
      const aTime = a.createdAt ?? parseDateTime(a.fecha)?.getTime() ?? 0;
      const bTime = b.createdAt ?? parseDateTime(b.fecha)?.getTime() ?? 0;
      return bTime - aTime;
    });
  }, [expedientes]);

  const filteredExpedientes = useMemo(() => {
    const searchValue = toUpper(auditoriaSearch);
    let items = [...sortedExpedientes];
    if (searchValue) {
      items = items.filter((e) => {
        const haystack = [
          e.fecha,
          e.servicio,
          e.receta,
          e.cedula,
          e.medicamento,
          e.dosis,
          e.condicion,
          e.farmaceutico,
        ]
          .filter(Boolean)
          .join(' ');
        return toUpper(haystack).includes(searchValue);
      });
    }
    return items;
  }, [sortedExpedientes, auditoriaSearch]);

  const sortedBitacora = useMemo(() => {
    return [...bitacora].sort((a, b) => {
      const aTime = a.createdAt ?? parseDateTime(a.fecha)?.getTime() ?? 0;
      const bTime = b.createdAt ?? parseDateTime(b.fecha)?.getTime() ?? 0;
      return bTime - aTime;
    });
  }, [bitacora]);

  const { recentTransactions, historicTransactions } = useMemo(() => {
    const searchValue = toUpper(kardexSearch);
    const matchesSearch = (t) => {
      if (!searchValue) return true;
      const haystack = [
        t.service,
        t.cama,
        t.prescription,
        t.pharmacist,
        t.rxType,
        t.type,
        t.date,
        t.cierreTurno,
        t.totalRecetas,
        t.totalMedicamento,
      ]
        .filter(Boolean)
        .join(' ');
      return toUpper(haystack).includes(searchValue);
    };
    const medTransactions = transactions.filter((t) => t.medId === selectedMedId && matchesSearch(t));
    if (searchValue) {
      const allSorted = medTransactions.slice().sort(compareTransactionsDesc);
      return { recentTransactions: allSorted, historicTransactions: [] };
    }
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 7);
    const recent = [];
    const historic = [];
    medTransactions.forEach((t) => {
      const whenTs = getTransactionTimestamp(t);
      if (whenTs >= cutoff.getTime()) {
        recent.push(t);
      } else {
        historic.push(t);
      }
    });
    const sortByDate = (a, b) => compareTransactionsDesc(a, b);
    return { recentTransactions: recent.sort(sortByDate), historicTransactions: historic.sort(sortByDate) };
  }, [transactions, selectedMedId, kardexSearch]);
  const kardexBalanceById = useMemo(() => {
    const medItems = transactions
      .filter((t) => t.medId === selectedMedId)
      .slice()
      .sort(compareTransactionsAsc);
    let running = 0;
    const balanceMap = {};
    medItems.forEach((t) => {
      if (
        t.isCierre &&
        (t.cierreTurno === 'CIERRE 24 HORAS' || t.cierreTurno === 'AJUSTE MANUAL SALDO')
      ) {
        running = Number(t.totalMedicamento) || 0;
      } else if (!t.isCierre) {
        const amount = Number(t.amount) || 0;
        running += t.type === 'IN' ? amount : -amount;
      }
      balanceMap[t.id] = running;
    });
    return balanceMap;
  }, [transactions, selectedMedId]);
  const totalReponerByCierreId = useMemo(() => {
    const medItems = transactions
      .filter((t) => t.medId === selectedMedId)
      .slice()
      .sort(compareTransactionsAsc);
    const map = {};
    const selectedMedication = medications.find((m) => m.id === selectedMedId);
    const quota = Number(selectedMedication?.quota) || 0;
    medItems.forEach((t, idx) => {
      if (!(t.isCierre && t.cierreTurno === 'CIERRE 24 HORAS')) return;
      const currentStockAtClose = Number(t.totalMedicamento) || 0;
      map[t.id] = Math.max(0, quota - currentStockAtClose);
    });
    return map;
  }, [transactions, selectedMedId, medications]);
  const pendingWriteKeySet = useMemo(() => {
    const set = new Set();
    (pendingWritesRef.current || []).forEach((w) => {
      set.add(`${w.collection}:${String(w.id)}`);
    });
    return set;
  }, [pendingCount]);
  const syncMetrics = useMemo(() => {
    const counters = syncEvents.reduce(
      (acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      },
      {},
    );
    return {
      totalEvents: syncEvents.length,
      enqueueCount: counters.enqueue || 0,
      flushOkCount: counters.flush_ok || 0,
      flushErrorCount: (counters.flush_error || 0) + (counters.retry_scheduled || 0),
      blockedCount: (counters.blocked_by_quota || 0) + (counters.enqueue_blocked || 0),
    };
  }, [syncEvents]);
  const releaseGateChecks = useMemo(() => {
    const hasPending = pendingCount > 0;
    const hasSyncError = Boolean(syncError);
    const hasQueueRisk = queueOverflow || writeBlockedByStorage;
    const hasRecentBackup = backupAuditLog.length > 0;
    const checks = [
      { key: 'no_pending', label: 'Sin pendientes de sincronizacion', ok: !hasPending },
      { key: 'no_sync_error', label: 'Sin errores activos de sincronizacion', ok: !hasSyncError },
      { key: 'no_queue_risk', label: 'Sin riesgo de cola local', ok: !hasQueueRisk },
      { key: 'recent_backup', label: 'Respaldo verificado en sesion', ok: hasRecentBackup },
    ];
    return {
      checks,
      approved: checks.every((c) => c.ok),
    };
  }, [pendingCount, syncError, queueOverflow, writeBlockedByStorage, backupAuditLog]);
  const getLiveBalanceForMedication = (medId) => {
    const medItems = transactions
      .filter((t) => t.medId === medId)
      .slice()
      .sort(compareTransactionsAsc);
    let running = 0;
    medItems.forEach((t) => {
      if (
        t.isCierre &&
        (t.cierreTurno === 'CIERRE 24 HORAS' || t.cierreTurno === 'AJUSTE MANUAL SALDO')
      ) {
        running = Number(t.totalMedicamento) || 0;
      } else if (!t.isCierre) {
        const amount = Number(t.amount) || 0;
        running += t.type === 'IN' ? amount : -amount;
      }
    });
    return running;
  };

  const recentPage = useMemo(() => paginate(recentTransactions, kardexRecentPage), [recentTransactions, kardexRecentPage]);
  const historicPage = useMemo(() => paginate(historicTransactions, kardexHistoricPage), [historicTransactions, kardexHistoricPage]);
  const auditoriaPageData = useMemo(() => paginate(filteredExpedientes, auditoriaPage), [filteredExpedientes, auditoriaPage]);
  const bitacoraPageData = useMemo(() => paginate(sortedBitacora, bitacoraPage), [sortedBitacora, bitacoraPage]);
  const configMedicationRows = useMemo(() => {
    const query = toUpper(configMedSearch);
    return [...medications]
      .filter((m) => !query || toUpper(m.name).includes(query) || toUpper(m.id).includes(query))
      .sort((a, b) => {
        const aAuto = AUTO_MED_NAME_PATTERN.test(a.name || '');
        const bAuto = AUTO_MED_NAME_PATTERN.test(b.name || '');
        if (aAuto !== bAuto) return aAuto ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '', 'es');
      });
  }, [medications, configMedSearch]);
  const recordsUsage = useMemo(() => {
    const limit = Math.max(1, maxRecordsLimit);
    const used = Math.max(totalTransactionsCount || 0, transactions.length);
    const pct = Math.min(100, Math.round((used / limit) * 100));
    return { used, limit, pct };
  }, [transactions.length, totalTransactionsCount, maxRecordsLimit]);
  const selectedCurrentStock = useMemo(
    () => currentInventory.find((m) => m.id === selectedMedId)?.stock ?? 0,
    [currentInventory, selectedMedId],
  );
  const totalReponerByMedId = useMemo(() => {
    const quotaByMedId = new Map(medications.map((m) => [m.id, Number(m.quota) || 0]));
    const latestByMedId = new Map();
    transactions.forEach((t) => {
      if (!(t.isCierre && t.cierreTurno === 'CIERRE 24 HORAS')) return;
      const medId = t.medId;
      if (!medId) return;
      const ts = getTransactionTimestamp(t);
      const quota = quotaByMedId.get(medId) || 0;
      const currentStockAtClose = Number(t.totalMedicamento) || 0;
      const totalReponer = Math.max(0, quota - currentStockAtClose);
      const prev = latestByMedId.get(medId);
      if (!prev || ts >= prev.ts) {
        latestByMedId.set(medId, { ts, totalReponer });
      }
    });
    const map = {};
    latestByMedId.forEach((value, medId) => {
      map[medId] = value.totalReponer;
    });
    return map;
  }, [transactions, medications]);
  const requestInventory = useMemo(
    () =>
      currentInventory.map((med) => ({
        ...med,
        totalReponer: totalReponerByMedId[med.id] ?? 0,
      })),
    [currentInventory, totalReponerByMedId],
  );
  const handleSave = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const now = new Date().toLocaleString('es-CR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: CR_TIMEZONE,
    });

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
        dosis: toUpper(formData.get('dosis')),
        rxType,
        rxQuantity,
        rxUsed,
        pharmacist: toUpper(formData.get('pharmacist') || pharmacists[0] || ''),
      };
      setTransactions([newTransaction, ...transactions]);
      enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
    } else if (modalType === 'kardex-edit') {
      const current = transactions.find((t) => t.id === editingTransactionId);
      const rxType = formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const medId = formData.get('medicationId');
      const prescription = toUpper(formData.get('prescription'));
      const rxUsed =
        rxType !== 'ABIERTA'
          ? 0
          : current?.rxType === 'ABIERTA'
            ? Math.min(current?.rxUsed ?? 0, rxQuantity)
            : Math.max(
                1,
                Math.min(
                  nextOpenRxUse(
                    transactions.filter((t) => t.id !== editingTransactionId),
                    medId,
                    prescription,
                    rxQuantity,
                  ),
                  rxQuantity || 1,
                ),
              );
      const updated = {
        id: editingTransactionId,
        date: now,
        createdAt: current?.createdAt ?? parseDateTime(current?.date || now)?.getTime() ?? Date.now(),
        medId,
        type: current?.type === 'IN' ? 'IN' : 'OUT',
        amount: parseInt(formData.get('amount'), 10),
        service: toUpper(formData.get('service')),
        cama: toUpper(formData.get('cama')),
        prescription,
        dosis: toUpper(formData.get('dosis')),
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
        dosis:
          dosisType === 'INFUSION'
            ? `INFUSION: ${formData.get('inf_amps')} AMPOLLAS EN ${formData.get('inf_vol')} CC A ${formData.get('inf_vel')} CC/HR DURACION: ${formData.get('inf_dur')} HRS`
            : toUpper(formData.get('dosis')),
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
        dosis:
          dosisType === 'INFUSION'
            ? `INFUSION: ${formData.get('inf_amps')} AMPOLLAS EN ${formData.get('inf_vol')} CC A ${formData.get('inf_vel')} CC/HR DURACION: ${formData.get('inf_dur')} HRS`
            : toUpper(formData.get('dosis')),
        condicion: toUpper(formData.get('condicion')),
        farmaceutico: toUpper(formData.get('farmaceutico')),
      };
      setExpedientes(expedientes.map((e) => (e.id === editingExpedienteId ? updated : e)));
      enqueueWrite({ type: 'set', collection: 'expedientes', id: updated.id, data: updated });
    } else if (modalType === 'auditoria-rate-change') {
      const parent = expedientes.find((e) => e.id === editingExpedienteId);
      if (parent) {
        const newRate = formData.get('new_rate');
        const newDuration = formData.get('new_duration');
        const newDosis = `CAMBIO VELOCIDAD: ${newRate} CC/HR - NUEVA DURACION: ${newDuration} HRS`;
        const newEntry = {
          ...parent,
          id: Date.now(),
          fecha: now,
          createdAt: Date.now(),
          dosis: toUpper(newDosis),
          condicion: 'CAMBIO VELOCIDAD INFUSION',
          farmaceutico: toUpper(formData.get('farmaceutico')),
        };
        setExpedientes([newEntry, ...expedientes]);
        enqueueWrite({ type: 'set', collection: 'expedientes', id: newEntry.id, data: newEntry });
      }
    } else if (modalType === 'cierre') {
      if (pendingCount > 0) {
        alert('No puede guardar cierre con pendientes de sincronizacion.');
        return;
      }
      const cierreTurno = toUpper(formData.get('turno'));
      const computedTotalMedicamento =
        cierreTurno === 'CIERRE 24 HORAS'
          ? Number(selectedCurrentStock) || 0
          : getLiveBalanceForMedication(selectedMedId);
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
        totalMedicamento: computedTotalMedicamento,
      };
      setTransactions([newCierre, ...transactions]);
      enqueueWrite({ type: 'set', collection: 'transactions', id: newCierre.id, data: newCierre });
    } else if (modalType === 'cross-check') {
      const selectedVerifier = toUpper(formData.get('crossCheckPharmacist'));
      if (!editingTransactionId || !selectedVerifier) return;
      const updatedTransactions = transactions.map((t) =>
        t.id === editingTransactionId
          ? {
              ...t,
              crossCheckPharmacist: selectedVerifier,
              crossCheckedAt: now,
            }
          : t,
      );
      const updatedTx = updatedTransactions.find((t) => t.id === editingTransactionId);
      setTransactions(updatedTransactions);
      if (updatedTx) enqueueWrite({ type: 'set', collection: 'transactions', id: updatedTx.id, data: updatedTx });
    } else if (modalType === 'open-rx-use') {
      if (!pendingOpenRxTransaction) return;
      const selectedPharmacist = toUpper(formData.get('openRxPharmacist'));
      const selectedAmount = parseInt(formData.get('openRxAmount'), 10);
      if (!selectedPharmacist) return;
      if (!Number.isFinite(selectedAmount) || selectedAmount <= 0) return;
      handleOpenRxUse(pendingOpenRxTransaction, selectedPharmacist, selectedAmount);
      setPendingOpenRxTransaction(null);
      setOpenRxAmountValue('');
    } else if (modalType === 'open-rx-adjust') {
      if (!pendingOpenRxAdjustTransaction) return;
      const selectedPharmacist = toUpper(formData.get('openRxAdjustPharmacist'));
      const selectedValue = parseInt(formData.get('openRxAdjustValue'), 10);
      if (!selectedPharmacist) return;
      if (!Number.isFinite(selectedValue) || selectedValue < 0) return;
      const rxQuantity = Number(pendingOpenRxAdjustTransaction.rxQuantity) || 0;
      if (rxQuantity > 0 && selectedValue > rxQuantity) {
        alert(`El nuevo dato no puede ser mayor a ${rxQuantity}.`);
        return;
      }
      const currentRxUsed = Number(pendingOpenRxAdjustTransaction.rxUsed) || 0;
      const updated = {
        ...pendingOpenRxAdjustTransaction,
        rxUsed: selectedValue,
        rxAdjusted: true,
        rxAdjustedAt: now,
        rxAdjustedBy: selectedPharmacist,
        rxAdjustedFrom: currentRxUsed,
      };
      setTransactions(transactions.map((t) => (t.id === updated.id ? updated : t)));
      enqueueWrite({ type: 'set', collection: 'transactions', id: updated.id, data: updated });
      setPendingOpenRxAdjustTransaction(null);
      setOpenRxAdjustValue('');
    } else if (modalType === 'auditoria-repeat') {
      if (!pendingRepeatExpediente) return;
      const selectedCondition = toUpper(formData.get('repeatCondicion'));
      const selectedPharmacist = toUpper(formData.get('repeatFarmaceutico'));
      if (!selectedCondition || !selectedPharmacist) return;
      const baseDosis = pendingRepeatExpediente.dosis || '';
      const isInfusion = baseDosis.toString().startsWith('INFUSION');
      const nextDosis = isInfusion
        ? `INFUSION: ${formData.get('repeat_inf_amps')} AMPOLLAS EN ${formData.get('repeat_inf_vol')} CC A ${formData.get('repeat_inf_vel')} CC/HR DURACION: ${formData.get('repeat_inf_dur')} HRS`
        : baseDosis;
      const duplicated = {
        ...pendingRepeatExpediente,
        id: Date.now(),
        fecha: now,
        createdAt: Date.now(),
        dosis: nextDosis,
        condicion: selectedCondition,
        farmaceutico: selectedPharmacist,
      };
      setExpedientes([duplicated, ...expedientes]);
      enqueueWrite({ type: 'set', collection: 'expedientes', id: duplicated.id, data: duplicated });
      setPendingRepeatExpediente(null);
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
      const nextServices = [newService, ...services.filter((s) => s !== newService)];
      setServices(nextServices);
      enqueueWrite({
        type: 'set',
        collection: 'catalog_services',
        id: toCatalogId(newService),
        data: { id: toCatalogId(newService), name: newService, createdAt: Date.now() },
      });
    } else if (modalType === 'pharmacist-add') {
      const newPharmacist = toUpper(formData.get('pharmacistName'));
      const nextPharmacists = [newPharmacist, ...pharmacists.filter((p) => p !== newPharmacist)];
      setPharmacists(nextPharmacists);
      enqueueWrite({
        type: 'set',
        collection: 'catalog_pharmacists',
        id: toCatalogId(newPharmacist),
        data: { id: toCatalogId(newPharmacist), name: newPharmacist, createdAt: Date.now() },
      });
    } else if (modalType === 'condition-add') {
      const newCondition = toUpper(formData.get('conditionName'));
      const nextCondiciones = [newCondition, ...condiciones.filter((c) => c !== newCondition)];
      setCondiciones(nextCondiciones);
      enqueueWrite({
        type: 'set',
        collection: 'catalog_condiciones',
        id: toCatalogId(newCondition),
        data: { id: toCatalogId(newCondition), name: newCondition, createdAt: Date.now() },
      });
    } else if (modalType === 'reintegro') {
      const rxQuantity = 0;
      const rxType = 'CERRADA';
      const medId = formData.get('medicationId');
      const receta = toUpper(formData.get('receta'));
      const motivo = toUpper(formData.get('motivo'));
      const prescription = `RECETA ${receta} - ${motivo}`;
      const newTransaction = {
        id: Date.now(),
        date: now,
        createdAt: Date.now(),
        medId,
        type: 'IN',
        amount: parseInt(formData.get('amount'), 10),
        service: 'REINTEGRO',
        cama: '',
        prescription, // Storing combined Receta + Motivo
        rxType,
        rxQuantity,
        rxUsed: 0,
        pharmacist: toUpper(formData.get('farmaceutico') || pharmacists[0] || ''),
      };
      setTransactions([newTransaction, ...transactions]);
      enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
    }
    setShowModal(false);
    setEditingMedId(null);
    setEditingTransactionId(null);
    setEditingExpedienteId(null);
    setRxTypeValue('CERRADA');
    setDosisType('UNICA');
    setPendingOpenRxTransaction(null);
    setPendingOpenRxAdjustTransaction(null);
    setOpenRxAmountValue('');
    setOpenRxAdjustValue('');
  };

  const getKardexRowClass = (t) => {
    if (t.isCierre) {
      return t.cierreTurno === 'CIERRE 24 HORAS' ? '!bg-rose-50 hover:!bg-rose-50' : '!bg-amber-50 hover:!bg-amber-50';
    }
    if (t.type === 'IN' && t.service === 'INGRESO A INVENTARIO') {
      return '!bg-emerald-50 hover:!bg-emerald-50';
    }
    return '';
  };

  const getTransactionLabel = (t) => {
    const formatShiftLabel = (value) => {
      const v = toUpper(value);
      if (v === 'PRIMER' || v === 'PRIMER TURNO') return 'PRIMER TURNO';
      if (v === 'SEGUNDO' || v === 'SEGUNDO TURNO') return 'SEGUNDO TURNO';
      if (v === 'TERCERO' || v === 'TERCER TURNO') return 'TERCER TURNO';
      return value || '';
    };
    if (t.isCierre) {
      return `CIERRE ${formatShiftLabel(t.cierreTurno)} - ${t.date}`;
    }
    const medName = medications.find((m) => m.id === t.medId)?.name || t.medId;
    const tipo = t.type === 'IN' ? 'INGRESO' : 'SALIDA';
    const receta = t.prescription ? `RECETA ${t.prescription}` : 'SIN RECETA';
    return `${tipo} ${t.amount} - ${medName} (${receta}) ${t.date}`;
  };


  if (authLoading) {
    return (
      <div className="fixed inset-0 bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl px-6 py-4 shadow-lg border border-slate-200">
          <p className="text-sm font-bold text-slate-700">Cargando sistema...</p>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl w-full max-w-md shadow-2xl overflow-hidden border border-slate-200">
          <div className="p-6 border-b border-slate-100 bg-slate-50">
            <div className="flex justify-center mb-4">
              <div className="bg-blue-600 p-3 rounded-xl shadow-lg shadow-blue-600/20">
                <Database size={24} className="text-white" />
              </div>
            </div>
            <h3 className="font-bold text-slate-800 uppercase tracking-tight text-sm text-center">Control de Drogas Hospitalizados</h3>
            <p className="text-xs text-slate-500 mt-2 text-center">Inicie sesion para acceder al sistema.</p>
          </div>
          <div className="p-6 space-y-4">
            <InputLabel label="Correo" name="authEmail" type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} />
            <InputLabel label="Contrasena" name="authPassword" type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} />
            {authError && <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-center"><p className="text-xs font-bold text-rose-600">{authError}</p></div>}

            <button
              onClick={() => handleAuth('login')}
              className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold text-xs shadow-sm hover:bg-slate-800 transition-all uppercase tracking-widest"
            >
              Ingresar
            </button>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200"></div>
              </div>
              <div className="relative flex justify-center text-[10px] uppercase font-bold tracking-widest">
                <span className="bg-white px-2 text-slate-400">O continuar con</span>
              </div>
            </div>

            <button
              onClick={handleGoogleAuth}
              className="w-full bg-white border border-slate-200 text-slate-700 py-3 rounded-lg font-bold text-xs shadow-sm hover:bg-slate-50 transition-all uppercase tracking-widest flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" /><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.26-.19-.58z" /><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
              Google
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          <NavItem active={activeTab === 'solicitud'} onClick={() => setActiveTab('solicitud')} icon={<ClipboardList size={18} />} label="Solicitud Reposicion" />
          <NavItem active={activeTab === 'config'} onClick={() => setActiveTab('config')} icon={<Database size={18} />} label="Configuracion" />
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
                      : activeTab === 'solicitud'
                        ? 'Solicitud de Reposicion'
                        : activeTab === 'config'
                          ? 'Configuracion'
                        : 'Resumen Operativo'}
            </h2>
            <p className="text-slate-500 text-sm">Control centralizado y validacion farmacoterapeutica.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(pendingCount > 0 || syncError || queueOverflow) && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg bg-rose-600 text-white">
                Datos sin sincronizar
              </span>
            )}
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border ${cloudStatus === 'Sincronizado'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : cloudStatus === 'Sin conexion'
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : cloudStatus === 'Carga parcial'
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
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
            {queueOverflow && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
                Cola llena (200)
              </span>
            )}
            {writeBlockedByStorage && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-rose-700">
                Escrituras bloqueadas por almacenamiento local
              </span>
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
            {syncErrors.length > 0 && (
              <button
                onClick={() => {
                  pendingWritesRef.current = [];
                  setPendingCount(0);
                  setSyncErrors([]);
                  setSyncError('');
                  setWriteBlockedByStorage(false);
                  localStorage.removeItem('pharmaPendingWrites');
                }}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
              >
                Limpiar Cola
              </button>
            )}
            {authUser && (
              <button
                onClick={async () => {
                  if (pendingCount > 0) {
                    alert('No puede salir con pendientes de sincronizacion. Sincronice o limpie cola primero.');
                    return;
                  }
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
                  setWriteBlockedByStorage(false);
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
                setIsQuickIngreso(false);
                setShowCatalogMenu(false);
                setRxTypeValue('CERRADA');
                setDosisType('UNICA');
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

            {/* KPIs Charts Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Consumption Trend */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
                <div className="mb-4">
                  <h3 className="font-bold text-slate-700 text-sm mb-1">Tendencia de Consumo</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Ultimos 7 dias</p>
                </div>
                <div className="h-32 flex items-end justify-between gap-2">
                  {kpiStats.trend.map((d, i) => {
                    const max = Math.max(...kpiStats.trend.map(t => t.value), 10);
                    const h = Math.max((d.value / max) * 100, 5);
                    return (
                      <div key={i} className="flex flex-col items-center w-full group">
                        <div className="relative w-full flex justify-end flex-col items-center h-full">
                          <div className="opacity-0 group-hover:opacity-100 absolute -top-6 text-[10px] font-bold bg-slate-800 text-white px-1.5 py-0.5 rounded transition-opacity">{d.value}</div>
                          <div style={{ height: `${h}%` }} className="w-full bg-blue-100 rounded-t-sm group-hover:bg-blue-600 transition-colors"></div>
                        </div>
                        <span className="text-[9px] font-bold text-slate-400 uppercase mt-2">{d.day}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 pt-4 border-t border-slate-50 flex justify-between items-center">
                  <span className="text-[10px] text-slate-400 font-bold uppercase">Total Salidas</span>
                  <span className="font-bold text-slate-800">{kpiStats.totalTrend}</span>
                </div>
              </div>

              {/* Service Distribution */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="mb-4">
                  <h3 className="font-bold text-slate-700 text-sm mb-1">Top Servicios</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Mayor demanda</p>
                </div>
                <div className="space-y-3">
                  {kpiStats.topServices.map((s, i) => (
                    <div key={i} className="space-y-1">
                      <div className="flex justify-between text-[10px] font-bold uppercase">
                        <span className="text-slate-600">{s.name}</span>
                        <span className="text-slate-900">{s.value}</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-50 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${(s.value / (kpiStats.topServices[0]?.value || 1)) * 100}%` }}
                          className="h-full bg-indigo-500 rounded-full"
                        ></div>
                      </div>
                    </div>
                  ))}
                  {kpiStats.topServices.length === 0 && <p className="text-xs text-slate-400">Sin datos de consumo.</p>}
                </div>
              </div>

              {/* Quality/Intervention */}
              <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col items-center justify-center text-center">
                <h3 className="font-bold text-slate-700 text-sm mb-6 w-full text-left">Calidad de Prescripcion</h3>
                <div className="relative w-32 h-32 mb-4">
                  <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                    <path
                      className="text-emerald-100"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.8"
                    />
                    <path
                      className={`${kpiStats.interventionRate > 15 ? 'text-rose-500' : 'text-emerald-500'}`}
                      strokeDasharray={`${100 - kpiStats.interventionRate}, 100`}
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.8"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold text-slate-800">{100 - kpiStats.interventionRate}%</span>
                    <span className="text-[8px] font-bold text-slate-400 uppercase">Aprobacion</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 w-full mt-2">
                  <div className="text-center p-2 bg-slate-50 rounded-lg">
                    <p className="text-[10px] text-slate-400 font-bold uppercase">Intervenciones</p>
                    <p className="text-lg font-bold text-rose-600">{kpiStats.interventionRate}%</p>
                  </div>
                  <div className="text-center p-2 bg-slate-50 rounded-lg">
                    <p className="text-[10px] text-slate-400 font-bold uppercase">Total Rev.</p>
                    <p className="text-lg font-bold text-slate-700">{expedientes.length}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h3 className="font-bold text-slate-700 text-sm">Estado Actual de Inventario</h3>
                <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                  <Clock size={12} /> Activo
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-slate-100">
                {requestInventory.map((med) => (
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
              <div className="flex-1 px-4 max-w-md">
                <input
                  ref={kardexSearchRef}
                  value={kardexSearch}
                  onChange={(e) => setKardexSearch(e.target.value)}
                  placeholder="Buscar receta, servicio, farmaceutico..."
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-semibold text-slate-700 focus:ring-2 focus:ring-blue-600 outline-none"
                />
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const hasKey = await requestSecurityKey();
                      if (!hasKey) return;
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
                      if (pendingCount > 0) {
                        alert('No puede realizar cierre con pendientes de sincronizacion.');
                        return;
                      }
                      setModalType('cierre');
                      setCierreTurnoValue('SEGUNDO');
                      setShowCatalogMenu(false);
                      setShowModal(true);
                    }}
                    className="bg-amber-500 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-amber-600"
                  >
                    Cierre Inventario
                  </button>
                  <button
                    onClick={() => {
                      setModalType('reintegro');
                      setShowCatalogMenu(false);
                      setShowModal(true);
                    }}
                    className="bg-indigo-600 text-white px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-indigo-700"
                  >
                    Reintegro
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
                    onClick={async () => {
                      const hasKey = await requestSecurityKey();
                      if (!hasKey) return;
                      const med = medications.find((m) => m.id === selectedMedId);
                      const movementCount = transactions.filter((t) => t.medId === selectedMedId).length;
                      const confirmDelete = window.confirm(
                        `Eliminar ${med?.name || 'medicamento'}? Se borraran ${movementCount} movimientos asociados.`,
                      );
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
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Saldo</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio / Cama</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Tipo de Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Receta</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Acciones</th>
                    <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaceutico</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recentPage.items.map((t) => (
                    <tr
                      key={t.id}
                      className={`hover:bg-slate-50/50 ${getKardexRowClass(t)}`}
                    >
                      <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                      <td className="px-6 py-4 text-center">
                        {t.isCierre ? (
                          <span className="font-bold uppercase text-amber-700">
                            {t.cierreTurno === 'CIERRE 24 HORAS' ? 'CIERRE' : 'INVENTARIO'}
                          </span>
                        ) : (
                          <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                            {t.amount}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="inline-flex items-center justify-center min-w-[72px] px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-xs font-bold text-slate-700">
                          {kardexBalanceById[t.id] ?? 0}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-700 text-center">
                        {t.isCierre ? (
                          <span className="font-bold text-slate-700">{(() => {
                            const v = toUpper(t.cierreTurno);
                            if (v === 'PRIMER' || v === 'PRIMER TURNO') return 'PRIMER TURNO';
                            if (v === 'SEGUNDO' || v === 'SEGUNDO TURNO') return 'SEGUNDO TURNO';
                            if (v === 'TERCERO' || v === 'TERCER TURNO') return 'TERCER TURNO';
                            return t.cierreTurno;
                          })()}</span>
                        ) : (
                          <>
                            {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                          </>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {t.isCierre ? (
                          t.cierreTurno === 'CIERRE 24 HORAS' ? (
                            <span className="text-xs font-bold uppercase text-slate-600">Total Reponer: {totalReponerByCierreId[t.id] ?? 0}</span>
                          ) : (
                            <span className="text-xs font-bold uppercase text-slate-600">Total Medicamento: {t.totalMedicamento}</span>
                          )
                        ) : t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPendingOpenRxTransaction(t);
                              setOpenRxPharmacistValue(pharmacists[0] || t.pharmacist || '');
                              setOpenRxAmountValue(String(getCurrentOpenRxAmount(transactions, t)));
                              setModalType('open-rx-use');
                              setShowModal(true);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setPendingOpenRxAdjustTransaction(t);
                              setOpenRxAdjustValue(String(t.rxUsed || 0));
                              setOpenRxAdjustPharmacistValue(pharmacists[0] || t.pharmacist || '');
                              setModalType('open-rx-adjust');
                              setShowModal(true);
                            }}
                            className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                            title="Click: registrar rebajo | Click derecho: ajustar X de Y"
                          >
                            <span className="inline-flex items-center gap-1">
                              {t.rxAdjusted && <span className="text-rose-600 text-[10px]" title={`Ajustado por ${t.rxAdjustedBy || 'N/A'}: ${t.rxAdjustedFrom ?? 0} -> ${t.rxUsed ?? 0} (${t.rxAdjustedAt || 'sin fecha'})`}>▲</span>}
                              {getRxProgress(t)}
                            </span>
                          </button>
                        ) : (
                          <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                        <div className="flex flex-col items-center">
                          <span>{t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}</span>
                          {!t.isCierre && t.dosis && (
                            <span className="text-[10px] text-slate-400 font-bold uppercase mt-1">{t.dosis}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 justify-center items-center min-w-[150px] mx-auto">
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
                          {t.isCierre && (
                            <span
                              aria-hidden="true"
                              className="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border border-transparent invisible"
                            >
                              Editar
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTransactionId(t.id);
                              setCrossCheckPharmacistValue(t.crossCheckPharmacist || pharmacists[0] || '');
                              setModalType('cross-check');
                              setShowModal(true);
                            }}
                            className={`p-1 rounded-md border ${
                              t.crossCheckPharmacist
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                                : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                            }`}
                            title={t.crossCheckPharmacist ? `Validado por ${t.crossCheckPharmacist}` : 'Control cruzado de saldo'}
                            aria-label="Control cruzado"
                          >
                            <Bell size={14} />
                          </button>
                          <button
                            onClick={() => {
                              requestStyledConfirm(`Eliminar movimiento: ${getTransactionLabel(t)}?`).then((confirmDelete) => {
                                if (!confirmDelete) return;
                                setTransactions(transactions.filter((tx) => tx.id !== t.id));
                                enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                              });
                            }}
                            className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                          >
                            Eliminar
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">
                        <div className="flex flex-col items-center gap-1">
                          <span>{t.pharmacist}</span>
                          <span className={`text-[9px] ${pendingWriteKeySet.has(`transactions:${String(t.id)}`) ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {pendingWriteKeySet.has(`transactions:${String(t.id)}`) ? 'PENDIENTE' : 'SYNC'}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {recentTransactions.length === 0 && (
                    <tr>
                      <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={8}>
                        Sin rebajos en la ultima semana.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <Pagination
                page={recentPage.page}
                totalPages={recentPage.totalPages}
                onPrev={() => setKardexRecentPage((prev) => Math.max(prev - 1, 1))}
                onNext={() => setKardexRecentPage((prev) => Math.min(prev + 1, recentPage.totalPages))}
              />
              {collectionLoadState.transactions.hasMore && (
                <div className="px-6 pb-4">
                  <div ref={(el) => { infiniteSentinelRefs.current.transactions = el; }} className="h-1" />
                  <button
                    type="button"
                    onClick={() => loadMoreCollection('transactions', setTransactions)}
                    disabled={collectionLoadState.transactions.loading}
                    className="w-full bg-white border border-slate-200 text-slate-700 py-2 rounded-md text-[11px] font-bold uppercase tracking-wider hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {collectionLoadState.transactions.loading ? 'Cargando...' : 'Cargar mas movimientos'}
                  </button>
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <h3 className="font-bold text-slate-700 text-sm">Historico (anteriores a 7 dias)</h3>
                <button
                  type="button"
                  onClick={() => setShowHistoric((prev) => !prev)}
                  className="text-xs font-bold text-blue-600 uppercase tracking-wider"
                >
                  {showHistoric ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
              <div className="px-6 py-2 border-b border-slate-100 bg-white">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Mostrando {transactions.length} movimientos cargados
                </p>
              </div>
              {showHistoric && (
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Fecha</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Movimiento</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Saldo</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Servicio / Cama</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Tipo de Receta</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Receta</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Acciones</th>
                      <th className="px-6 py-3 font-bold text-slate-500 text-[10px] uppercase text-center">Farmaceutico</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historicPage.items.map((t) => (
                      <tr key={t.id} className={`hover:bg-slate-50/50 ${getKardexRowClass(t)}`}>
                        <td className="px-6 py-4 text-slate-500 text-center">{t.date}</td>
                        <td className="px-6 py-4 text-center">
                          {t.isCierre ? (
                            <span className="font-bold uppercase text-amber-700">
                              {t.cierreTurno === 'CIERRE 24 HORAS' ? 'CIERRE' : 'INVENTARIO'}
                            </span>
                          ) : (
                            <span className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                              {t.amount}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className="inline-flex items-center justify-center min-w-[72px] px-2 py-1 rounded-md bg-slate-50 border border-slate-200 text-xs font-bold text-slate-700">
                            {kardexBalanceById[t.id] ?? 0}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-medium text-slate-700 text-center">
                          {t.isCierre ? (
                            <span className="font-bold text-slate-700">{(() => {
                              const v = toUpper(t.cierreTurno);
                              if (v === 'PRIMER' || v === 'PRIMER TURNO') return 'PRIMER TURNO';
                              if (v === 'SEGUNDO' || v === 'SEGUNDO TURNO') return 'SEGUNDO TURNO';
                              if (v === 'TERCERO' || v === 'TERCER TURNO') return 'TERCER TURNO';
                              return t.cierreTurno;
                            })()}</span>
                          ) : (
                            <>
                              {t.service} {t.cama && <span className="text-slate-400 font-normal">/ {t.cama}</span>}
                            </>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {t.isCierre ? (
                            t.cierreTurno === 'CIERRE 24 HORAS' ? (
                              <span className="text-xs font-bold uppercase text-slate-600">Total Reponer: {totalReponerByCierreId[t.id] ?? 0}</span>
                            ) : (
                              <span className="text-xs font-bold uppercase text-slate-600">Total Medicamento: {t.totalMedicamento}</span>
                            )
                          ) : t.rxType === 'ABIERTA' && t.rxQuantity > 0 ? (
                            <button
                              type="button"
                              onClick={() => {
                                setPendingOpenRxTransaction(t);
                                setOpenRxPharmacistValue(pharmacists[0] || t.pharmacist || '');
                                setOpenRxAmountValue(String(getCurrentOpenRxAmount(transactions, t)));
                                setModalType('open-rx-use');
                                setShowModal(true);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setPendingOpenRxAdjustTransaction(t);
                                setOpenRxAdjustValue(String(t.rxUsed || 0));
                                setOpenRxAdjustPharmacistValue(pharmacists[0] || t.pharmacist || '');
                                setModalType('open-rx-adjust');
                                setShowModal(true);
                              }}
                              className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs font-bold text-slate-700 hover:bg-slate-100"
                              title="Click: registrar rebajo | Click derecho: ajustar X de Y"
                            >
                              <span className="inline-flex items-center gap-1">
                                {t.rxAdjusted && <span className="text-rose-600 text-[10px]" title={`Ajustado por ${t.rxAdjustedBy || 'N/A'}: ${t.rxAdjustedFrom ?? 0} -> ${t.rxUsed ?? 0} (${t.rxAdjustedAt || 'sin fecha'})`}>▲</span>}
                                {getRxProgress(t)}
                              </span>
                            </button>
                          ) : (
                            <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                          {t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}
                        </td>
                      <td className="px-6 py-4">
                          <div className="flex gap-2 justify-center items-center min-w-[150px] mx-auto">
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
                            {t.isCierre && (
                              <span
                                aria-hidden="true"
                                className="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border border-transparent invisible"
                              >
                                Editar
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTransactionId(t.id);
                                setCrossCheckPharmacistValue(t.crossCheckPharmacist || pharmacists[0] || '');
                                setModalType('cross-check');
                                setShowModal(true);
                              }}
                              className={`p-1 rounded-md border ${
                                t.crossCheckPharmacist
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                                  : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                              }`}
                              title={t.crossCheckPharmacist ? `Validado por ${t.crossCheckPharmacist}` : 'Control cruzado de saldo'}
                              aria-label="Control cruzado"
                            >
                              <Bell size={14} />
                            </button>
                            <button
                              onClick={() => {
                                requestStyledConfirm(`Eliminar movimiento: ${getTransactionLabel(t)}?`).then((confirmDelete) => {
                                  if (!confirmDelete) return;
                                  setTransactions(transactions.filter((tx) => tx.id !== t.id));
                                  enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                                });
                              }}
                              className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center text-[10px] font-bold text-slate-400 uppercase">
                          <div className="flex flex-col items-center gap-1">
                            <span>{t.pharmacist}</span>
                            <span className={`text-[9px] ${pendingWriteKeySet.has(`transactions:${String(t.id)}`) ? 'text-amber-600' : 'text-emerald-600'}`}>
                              {pendingWriteKeySet.has(`transactions:${String(t.id)}`) ? 'PENDIENTE' : 'SYNC'}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {historicTransactions.length === 0 && (
                      <tr>
                        <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={8}>
                          Sin historico anterior.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
              {showHistoric && (
                <Pagination
                  page={historicPage.page}
                  totalPages={historicPage.totalPages}
                  onPrev={() => setKardexHistoricPage((prev) => Math.max(prev - 1, 1))}
                  onNext={() => setKardexHistoricPage((prev) => Math.min(prev + 1, historicPage.totalPages))}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'auditoria' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center bg-slate-50/50">
              <div className="relative w-full max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                <input
                  type="text"
                  placeholder="Buscar expedientes..."
                  value={auditoriaSearch}
                  onChange={(e) => setAuditoriaSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-600 outline-none"
                />
              </div>
            </div>
            <div className="px-6 py-2 border-b border-slate-100 bg-white">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Mostrando {expedientes.length} revisiones cargadas
              </p>
            </div>
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
                {auditoriaPageData.items.map((e) => (
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
                        className={`px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-wider ${e.condicion === 'VALIDACION' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
                          }`}
                      >
                        {e.condicion}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2 justify-center items-center min-w-[170px] mx-auto">
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
                          type="button"
                          onClick={() => {
                            setPendingRepeatExpediente(e);
                            setRepeatConditionValue(e.condicion || condiciones[0] || '');
                            setRepeatPharmacistValue(e.farmaceutico || pharmacists[0] || '');
                            setModalType('auditoria-repeat');
                            setShowModal(true);
                          }}
                          className="bg-blue-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-blue-700"
                          title="Repetir revision"
                        >
                          Repetir
                        </button>
                        {e.dosis && e.dosis.toString().startsWith('INFUSION') && (
                          <button
                            onClick={() => {
                              setEditingExpedienteId(e.id);
                              setModalType('auditoria-rate-change');
                              setShowModal(true);
                            }}
                            className="bg-blue-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-blue-700 flex items-center justify-center"
                            title="Registrar Cambio de Velocidad"
                          >
                            <PlusCircle size={14} />
                          </button>
                        )}
                        {!(e.dosis && e.dosis.toString().startsWith('INFUSION')) && (
                          <span
                            aria-hidden="true"
                            className="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border border-transparent invisible flex items-center justify-center"
                          >
                            <PlusCircle size={14} />
                          </span>
                        )}
                        <button
                          onClick={() => {
                            const confirmDelete = window.confirm(
                              `Eliminar expediente de ${e.cedula} (${e.medicamento}) - Receta ${e.receta || '---'}?`,
                            );
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
                {sortedExpedientes.length === 0 && (
                  <tr>
                    <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={8}>
                      Sin registros en auditoria.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <Pagination
              page={auditoriaPageData.page}
              totalPages={auditoriaPageData.totalPages}
              onPrev={() => setAuditoriaPage((prev) => Math.max(prev - 1, 1))}
              onNext={() => setAuditoriaPage((prev) => Math.min(prev + 1, auditoriaPageData.totalPages))}
            />
            {collectionLoadState.expedientes.hasMore && (
              <div className="px-6 pb-4">
                <div ref={(el) => { infiniteSentinelRefs.current.expedientes = el; }} className="h-1" />
                <button
                  type="button"
                  onClick={() => loadMoreCollection('expedientes', setExpedientes)}
                  disabled={collectionLoadState.expedientes.loading}
                  className="w-full bg-white border border-slate-200 text-slate-700 py-2 rounded-md text-[11px] font-bold uppercase tracking-wider hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {collectionLoadState.expedientes.loading ? 'Cargando...' : 'Cargar mas revisiones'}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'bitacora' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-2 border-b border-slate-100 bg-white">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Mostrando {bitacora.length} registros cargados
              </p>
            </div>
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
                {bitacoraPageData.items.map((b) => (
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
                {sortedBitacora.length === 0 && (
                  <tr>
                    <td className="px-6 py-6 text-center text-xs text-slate-400" colSpan={4}>
                      Sin registros en la bitacora.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <Pagination
              page={bitacoraPageData.page}
              totalPages={bitacoraPageData.totalPages}
              onPrev={() => setBitacoraPage((prev) => Math.max(prev - 1, 1))}
              onNext={() => setBitacoraPage((prev) => Math.min(prev + 1, bitacoraPageData.totalPages))}
            />
            {collectionLoadState.bitacora.hasMore && (
              <div className="px-6 pb-4">
                <div ref={(el) => { infiniteSentinelRefs.current.bitacora = el; }} className="h-1" />
                <button
                  type="button"
                  onClick={() => loadMoreCollection('bitacora', setBitacora)}
                  disabled={collectionLoadState.bitacora.loading}
                  className="w-full bg-white border border-slate-200 text-slate-700 py-2 rounded-md text-[11px] font-bold uppercase tracking-wider hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {collectionLoadState.bitacora.loading ? 'Cargando...' : 'Cargar mas bitacora'}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'solicitud' && (
          <div className="space-y-6">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center bg-slate-50/50 gap-4">
                <div>
                  <h3 className="font-bold text-slate-700 text-sm">Generar Solicitud de Pedido</h3>
                  <p className="text-[10px] text-slate-500 uppercase">Seleccione las cantidades a reponer segun el stock actual</p>
                </div>
                <div className="flex flex-col md:flex-row items-end gap-4 w-full md:w-auto">
                  <div className="w-full md:w-64">
                    <label className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Farmaceutico a cargo</label>
                    <select
                      value={requestPharmacist}
                      onChange={(e) => setRequestPharmacist(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm focus:ring-2 focus:ring-emerald-600 outline-none font-medium"
                    >
                      <option value="">Seleccionar...</option>
                      {pharmacists.map((ph, i) => (
                        <option key={i} value={ph}>
                          {ph}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={generateRequestPDF}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-bold text-xs flex items-center gap-2 transition-all shadow-sm h-10"
                  >
                    <FileText size={16} /> Generar PDF
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                      <th className="px-6 py-3 w-16 text-center">Sel.</th>
                      <th className="px-6 py-3">Medicamento</th>
                      <th className="px-6 py-3 text-center">Stock Actual</th>
                      <th className="px-6 py-3 text-center">Total a Reponer</th>
                      <th className="px-6 py-3 text-center w-32">Solicitar</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {requestInventory.map((med) => (
                      <tr key={med.id} className={`hover:bg-slate-50 transition-colors ${selectedRequestMeds[med.id] ? 'bg-emerald-50/30' : ''}`}>
                        <td className="px-6 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={!!selectedRequestMeds[med.id]}
                            onChange={() => toggleRequestMed(med.id)}
                            className="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-600 cursor-pointer"
                          />
                        </td>
                        <td className="px-6 py-3 font-semibold text-slate-700">{med.name}</td>
                        <td className={`px-6 py-3 text-center font-bold ${med.stock < 15 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {med.stock}
                        </td>
                        <td className="px-6 py-3 text-center text-slate-500">{med.totalReponer}</td>
                        <td className="px-6 py-2 text-center">
                          <input
                            type="number"
                            min="0"
                            value={requestQuantities[med.id] ?? ''}
                            onChange={(e) => handleRequestChange(med.id, e.target.value)}
                            disabled={!selectedRequestMeds[med.id]}
                            className={`w-20 border border-slate-200 rounded-md py-1 px-2 text-center text-sm font-bold focus:ring-2 focus:ring-blue-600 outline-none ${!selectedRequestMeds[med.id] ? 'bg-slate-100 text-slate-400' : 'bg-white'}`}
                            placeholder="0"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {activeTab === 'config' && (
          <div className="space-y-4">
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="font-bold text-slate-800 text-sm">Configuracion de Medicamentos</h3>
              <p className="text-xs text-slate-500 mt-1">
                Renombre los medicamentos para corregir etiquetas y mostrar el nombre real en todo el sistema.
              </p>
              <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase text-slate-500">Uso de Registros</p>
                    <p className="text-sm font-bold text-slate-800">
                      {recordsUsage.used.toLocaleString('es-CR')} / {recordsUsage.limit.toLocaleString('es-CR')} ({recordsUsage.pct}%)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1000"
                      step="1000"
                      value={maxRecordsDraft}
                      onChange={(e) => setMaxRecordsDraft(e.target.value)}
                      className="w-36 bg-white border border-slate-200 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium"
                    />
                    <button
                      type="button"
                      onClick={saveMaxRecordsLimit}
                      className="bg-slate-900 text-white px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-800"
                    >
                      Actualizar Limite
                    </button>
                  </div>
                </div>
                <div className="mt-3 h-3 w-full bg-slate-200 rounded-full overflow-hidden">
                  <div
                    style={{ width: `${recordsUsage.pct}%` }}
                    className={`h-full ${recordsUsage.pct >= 90 ? 'bg-rose-600' : recordsUsage.pct >= 70 ? 'bg-amber-500' : 'bg-emerald-600'}`}
                  />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={downloadDatabaseBackup}
                  className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-emerald-700"
                >
                  Descargar Base JSON
                </button>
                <button
                  type="button"
                  onClick={() => restoreInputRef.current?.click()}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-blue-700"
                >
                  Cargar y Restaurar JSON
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => restoreDatabaseBackup(e.target.files?.[0])}
                />
              </div>
              <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50">
                <p className="text-[10px] font-bold uppercase text-slate-500">Auditoria de Restauraciones (ultimas 20)</p>
                <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
                  {restoreAuditLog.map((r, idx) => (
                    <div key={`${r.at}-${idx}`} className="text-[10px] text-slate-700 border border-slate-200 bg-white rounded-md px-2 py-1">
                      [{r.at}] {r.fileName} v{r.backupVersion} - TX:{r.summary?.transactions ?? 0} EXP:{r.summary?.expedientes ?? 0}
                    </div>
                  ))}
                  {restoreAuditLog.length === 0 && <p className="text-[10px] text-slate-400">Sin restauraciones registradas en esta sesion.</p>}
                </div>
              </div>
              <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-slate-50">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10px] font-bold uppercase text-slate-500">Gate de Release (Fase 5)</p>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md border ${
                      releaseGateChecks.approved
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-rose-200 bg-rose-50 text-rose-700'
                    }`}
                  >
                    {releaseGateChecks.approved ? 'Aprobado' : 'Bloqueado'}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  {releaseGateChecks.checks.map((check) => (
                    <div key={check.key} className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-2 py-1">
                      <span className="text-[10px] font-semibold text-slate-700">{check.label}</span>
                      <span className={`text-[10px] font-bold ${check.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {check.ok ? 'OK' : 'FALLA'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-4">
                <InputLabel
                  label="Buscar por nombre o id"
                  name="configMedSearch"
                  value={configMedSearch}
                  onChange={(e) => setConfigMedSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="font-bold text-slate-800 text-sm">Ajuste Manual de Saldo</h3>
              <p className="text-xs text-slate-500 mt-1">
                Permite corregir el saldo base de un medicamento. La app seguira calculando desde este ajuste.
              </p>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <SelectLabel
                  label="Medicamento"
                  name="adjustMedId"
                  options={sortedMedications.map((m) => ({ value: m.id, label: m.name }))}
                  isObject
                  value={adjustMedId}
                  onChange={(e) => setAdjustMedId(e.target.value)}
                />
                <InputLabel
                  label="Nuevo Saldo"
                  name="adjustBalance"
                  type="number"
                  min="0"
                  value={adjustBalanceValue}
                  onChange={(e) => setAdjustBalanceValue(e.target.value)}
                />
                <SelectLabel
                  label="Farmaceutico"
                  name="adjustPharmacist"
                  options={pharmacists}
                  value={adjustPharmacist}
                  onChange={(e) => setAdjustPharmacist(e.target.value)}
                />
                <button
                  type="button"
                  onClick={applyManualBalanceAdjustment}
                  className="bg-amber-600 text-white px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-amber-700"
                >
                  Aplicar Ajuste
                </button>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-3 border-b border-slate-100 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 grid grid-cols-12 gap-3">
                <div className="col-span-3">ID</div>
                <div className="col-span-5">Nombre</div>
                <div className="col-span-2 text-center">Tipo</div>
                <div className="col-span-2 text-right">Accion</div>
              </div>
              <div className="divide-y divide-slate-100">
                {configMedicationRows.map((med) => (
                  <div key={med.id} className="px-6 py-3 grid grid-cols-12 gap-3 items-center">
                    <div className="col-span-3 text-xs font-semibold text-slate-500">{med.id}</div>
                    <div className="col-span-5">
                      {editingConfigMedId === med.id ? (
                        <input
                          value={configMedNameDraft}
                          onChange={(e) => setConfigMedNameDraft(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium uppercase"
                        />
                      ) : (
                        <span className={`text-sm font-semibold ${AUTO_MED_NAME_PATTERN.test(med.name || '') ? 'text-rose-600' : 'text-slate-700'}`}>
                          {med.name}
                        </span>
                      )}
                    </div>
                    <div className="col-span-2 text-center text-xs font-bold text-slate-500 uppercase">{med.type}</div>
                    <div className="col-span-2 flex justify-end gap-2">
                      {editingConfigMedId === med.id ? (
                        <>
                          <button
                            type="button"
                            onClick={saveConfigMedicationName}
                            className="bg-emerald-600 text-white px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-emerald-700"
                          >
                            Guardar
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingConfigMedId(null);
                              setConfigMedNameDraft('');
                            }}
                            className="bg-slate-200 text-slate-700 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-300"
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startConfigMedicationEdit(med)}
                          className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-blue-700"
                        >
                          Renombrar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {configMedicationRows.length === 0 && (
                  <div className="px-6 py-6 text-xs text-slate-400">No hay medicamentos que coincidan con la busqueda.</div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>



      {authUser && (authLoading || cloudLoading || !cloudReady) && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-40">
          <div className="bg-white rounded-xl px-6 py-4 shadow-lg border border-slate-200">
            <p className="text-sm font-bold text-slate-700">Cargando datos...</p>
          </div>
        </div>
      )}
      {securityPromptOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Validacion de Seguridad</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-600">Ingrese clave de seguridad para continuar.</p>
              <input
                type="password"
                value={securityPromptValue}
                onChange={(e) => setSecurityPromptValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') resolveSecurityPrompt(true);
                  if (e.key === 'Escape') resolveSecurityPrompt(false);
                }}
                autoFocus
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolveSecurityPrompt(false)}
                  className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => resolveSecurityPrompt(true)}
                  className="bg-blue-600 text-white px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-blue-700"
                >
                  Aceptar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmPromptOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Confirmar Accion</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-700">{confirmPromptMessage}</p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolveStyledConfirm(false)}
                  className="bg-white border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => resolveStyledConfirm(true)}
                  className="bg-rose-600 text-white px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-rose-700"
                >
                  Aceptar
                </button>
              </div>
            </div>
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
                      : modalType === 'auditoria-rate-change'
                          ? 'Cambio de Velocidad Infusion'
                          : modalType === 'auditoria-repeat'
                            ? 'Repetir Revision'
                          : modalType === 'bitacora'
                            ? 'Nuevo Registro de Bitacora'
                            : modalType === 'cierre'
                              ? 'Cierre de Inventario'
                              : modalType === 'open-rx-use'
                                ? 'Registrar Rebajo Receta Abierta'
                              : modalType === 'open-rx-adjust'
                                ? 'Ajustar Progreso Receta Abierta'
                              : modalType === 'cross-check'
                                ? 'Control Cruzado de Saldo'
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
                                              : modalType === 'reintegro'
                                                ? 'Reintegro de Medicamento'
                                                : 'Nuevo Medicamento'}
              </h3>
              <button
                onClick={() => {
                  setShowModal(false);
                  setEditingMedId(null);
                  setEditingTransactionId(null);
                  setEditingExpedienteId(null);
                  setIsQuickIngreso(false);
                  setRxTypeValue('CERRADA');
                  setDosisType('UNICA');
                  setPendingOpenRxTransaction(null);
                  setPendingOpenRxAdjustTransaction(null);
                  setOpenRxAmountValue('');
                  setOpenRxAdjustValue('');
                }}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
              >
                Cerrar
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
                      className="uppercase"
                      defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.cedula || ''}
                    />
                    <InputLabel
                      label="N Receta"
                      name="receta"
                      required
                      className="uppercase"
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

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-slate-500 uppercase">Configuracion Dosis</label>
                    <div className="flex bg-slate-100 p-1 rounded-lg">
                      <button
                        type="button"
                        onClick={() => setDosisType('UNICA')}
                        className={`flex-1 text-xs font-bold py-1.5 rounded-md transition-all ${dosisType === 'UNICA' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                          }`}
                      >
                        Dosis y Frecuencia
                      </button>
                      <button
                        type="button"
                        onClick={() => setDosisType('INFUSION')}
                        className={`flex-1 text-xs font-bold py-1.5 rounded-md transition-all ${dosisType === 'INFUSION' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                          }`}
                      >
                        Infusion Continua
                      </button>
                    </div>
                  </div>

                  {dosisType === 'UNICA' ? (
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase">Dosis y Via</label>
                      <textarea
                        name="dosis"
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none h-20 uppercase"
                        required
                        defaultValue={expedientes.find((e) => e.id === editingExpedienteId)?.dosis || ''}
                      ></textarea>
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Ampollas</label>
                        <input name="inf_amps" type="number" step="0.5" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Diluyente (cc)</label>
                        <input name="inf_vol" type="number" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Velocidad (cc/hr)</label>
                        <input name="inf_vel" type="number" step="0.1" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Duracion (hr)</label>
                        <input name="inf_dur" type="number" step="0.5" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" required />
                      </div>
                    </div>

                  )}
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
              ) : modalType === 'auditoria-rate-change' ? (
                <>
                  <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 flex flex-col gap-2 mb-4">
                    <p className="text-xs font-bold text-slate-700">
                      PACIENTE: <span className="text-blue-600">{expedientes.find((e) => e.id === editingExpedienteId)?.cedula}</span>
                    </p>
                    <p className="text-xs font-bold text-slate-700">
                      HUMANO: <span className="text-blue-600">{expedientes.find((e) => e.id === editingExpedienteId)?.medicamento}</span>
                    </p>
                    <p className="text-[10px] text-slate-500 uppercase">
                      DOSIS ACTUAL: {expedientes.find((e) => e.id === editingExpedienteId)?.dosis}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase">Nueva Velocidad (cc/hr)</label>
                      <input
                        name="new_rate"
                        type="number"
                        step="0.1"
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600"
                        required
                        autoFocus
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase">Nueva Duracion (hr)</label>
                      <input
                        name="new_duration"
                        type="number"
                        step="0.5"
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600"
                        required
                      />
                    </div>
                  </div>
                  <SelectLabel
                    label="Farmaceutico"
                    name="farmaceutico"
                    options={pharmacists}
                    defaultValue={pharmacists[0]}
                  />
                </>
              ) : modalType === 'cierre' ? (
                <>
                  <SelectLabel
                    label="Turno"
                    name="turno"
                    options={['PRIMER TURNO', 'SEGUNDO TURNO', 'TERCER TURNO', 'CIERRE 24 HORAS']}
                    defaultValue={cierreTurnoValue}
                    onChange={(e) => setCierreTurnoValue(e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <InputLabel label="Total de Recetas" name="totalRecetas" type="number" required />
                    <InputLabel
                      label="Total de Medicamento"
                      name="totalMedicamento"
                      type="number"
                      value={selectedCurrentStock}
                      readOnly
                    />
                  </div>
                  <SelectLabel label="Farmaceutico" name="farmaceutico" options={pharmacists} />
                </>
              ) : modalType === 'cross-check' ? (
                <>
                  <SelectLabel
                    label="Farmaceutico Verificador"
                    name="crossCheckPharmacist"
                    options={pharmacists}
                    defaultValue={crossCheckPharmacistValue}
                    onChange={(e) => setCrossCheckPharmacistValue(e.target.value)}
                    required
                  />
                </>
              ) : modalType === 'open-rx-use' ? (
                <>
                  <InputLabel
                    label="Cantidad a Rebajar"
                    name="openRxAmount"
                    type="number"
                    min="1"
                    value={openRxAmountValue}
                    onChange={(e) => setOpenRxAmountValue(e.target.value)}
                    required
                  />
                  <SelectLabel
                    label="Farmaceutico que Realiza Rebajo"
                    name="openRxPharmacist"
                    options={pharmacists}
                    defaultValue={openRxPharmacistValue}
                    onChange={(e) => setOpenRxPharmacistValue(e.target.value)}
                    required
                  />
                </>
              ) : modalType === 'open-rx-adjust' ? (
                <>
                  <InputLabel
                    label="Dato Actual"
                    name="openRxAdjustCurrent"
                    value={String(pendingOpenRxAdjustTransaction?.rxUsed ?? 0)}
                    disabled
                  />
                  <InputLabel
                    label="Nuevo Dato"
                    name="openRxAdjustValue"
                    type="number"
                    min="0"
                    max={String(pendingOpenRxAdjustTransaction?.rxQuantity ?? 0)}
                    value={openRxAdjustValue}
                    onChange={(e) => setOpenRxAdjustValue(e.target.value)}
                    required
                  />
                  <SelectLabel
                    label="Farmaceutico"
                    name="openRxAdjustPharmacist"
                    options={pharmacists}
                    defaultValue={openRxAdjustPharmacistValue}
                    onChange={(e) => setOpenRxAdjustPharmacistValue(e.target.value)}
                    required
                  />
                </>
              ) : modalType === 'auditoria-repeat' ? (
                <>
                  {pendingRepeatExpediente?.dosis?.toString().startsWith('INFUSION') && (
                    <div className="grid grid-cols-4 gap-2 bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Ampollas</label>
                        <input name="repeat_inf_amps" type="number" step="0.5" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" defaultValue={parseInfusionDose(pendingRepeatExpediente?.dosis)?.amps || ''} required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Diluyente (cc)</label>
                        <input name="repeat_inf_vol" type="number" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" defaultValue={parseInfusionDose(pendingRepeatExpediente?.dosis)?.vol || ''} required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Velocidad (cc/hr)</label>
                        <input name="repeat_inf_vel" type="number" step="0.1" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" defaultValue={parseInfusionDose(pendingRepeatExpediente?.dosis)?.vel || ''} required />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[9px] font-bold text-slate-500 uppercase">Duracion (hr)</label>
                        <input name="repeat_inf_dur" type="number" step="0.5" className="w-full bg-white border border-slate-200 rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-blue-600" defaultValue={parseInfusionDose(pendingRepeatExpediente?.dosis)?.dur || ''} required />
                      </div>
                    </div>
                  )}
                  <SelectLabel
                    label="Condicion"
                    name="repeatCondicion"
                    options={condiciones}
                    defaultValue={repeatConditionValue}
                    onChange={(e) => setRepeatConditionValue(e.target.value)}
                    required
                  />
                  <SelectLabel
                    label="Farmaceutico"
                    name="repeatFarmaceutico"
                    options={pharmacists}
                    defaultValue={repeatPharmacistValue}
                    onChange={(e) => setRepeatPharmacistValue(e.target.value)}
                    required
                  />
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
                    <>
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
                      <SelectLabel
                        label="Farmaceutico"
                        name="pharmacist"
                        options={pharmacists}
                        defaultValue={transactions.find((t) => t.id === editingTransactionId)?.pharmacist || pharmacists[0]}
                        required
                      />
                    </>
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
                        <InputLabel
                          label="Dosis"
                          name="dosis"
                          className="uppercase"
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.dosis || ''}
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
                  )}
                </>
              ) : modalType === 'reintegro' ? (
                <>
                  <SelectLabel
                    label="Medicamento"
                    name="medicationId"
                    options={sortedMedications.map((m) => ({ value: m.id, label: m.name }))}
                    isObject
                    defaultValue={selectedMedId}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <InputLabel label="Cantidad a Reintegrar" name="amount" type="number" required />
                    <InputLabel label="N Receta" name="receta" required />
                  </div>
                  <InputLabel label="Motivo del Reintegro" name="motivo" required placeholder="Especifique la razon..." />
                  <SelectLabel label="Farmaceutico" name="farmaceutico" options={pharmacists} />
                </>
              ) : modalType === 'sync-log' ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-500">Ultimos errores de sincronizacion (max 50).</p>
                  <div className="grid grid-cols-2 gap-2 text-[10px] font-bold uppercase">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">Eventos: {syncMetrics.totalEvents}</div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">Pendientes: {pendingCount}</div>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">Flush OK: {syncMetrics.flushOkCount}</div>
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">Errores/Retry: {syncMetrics.flushErrorCount}</div>
                  </div>
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
                  <p className="text-xs text-slate-500">Eventos recientes de sincronizacion (max 200).</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {syncEvents.map((evt, idx) => (
                      <div key={`${evt.at}-${evt.type}-${idx}`} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                        <span className="text-xs font-bold text-slate-700">
                          [{evt.at}] {evt.type} - {evt.detail}
                        </span>
                      </div>
                    ))}
                    {syncEvents.length === 0 && <p className="text-xs text-slate-400">Sin eventos registrados.</p>}
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
                  <InputLabel
                    label="Buscar"
                    name="catalogSearch"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                  <div className="space-y-2">
                    {services
                      .filter((name) => toUpper(name).includes(toUpper(catalogSearch)))
                      .map((name) => (
                        <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          <span className="text-xs font-bold text-slate-700">{name}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const confirmDelete = window.confirm(`Eliminar servicio: ${name}?`);
                              if (!confirmDelete) return;
                              setServices(services.filter((s) => s !== name));
                              enqueueWrite({ type: 'delete', collection: 'catalog_services', id: toCatalogId(name) });
                            }}
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
                  <InputLabel
                    label="Buscar"
                    name="catalogSearch"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                  <div className="space-y-2">
                    {pharmacists
                      .filter((name) => toUpper(name).includes(toUpper(catalogSearch)))
                      .map((name) => (
                        <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          <span className="text-xs font-bold text-slate-700">{name}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const confirmDelete = window.confirm(`Eliminar farmaceutico: ${name}?`);
                              if (!confirmDelete) return;
                              setPharmacists(pharmacists.filter((p) => p !== name));
                              enqueueWrite({ type: 'delete', collection: 'catalog_pharmacists', id: toCatalogId(name) });
                            }}
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
                  <InputLabel
                    label="Buscar"
                    name="catalogSearch"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                  />
                  <div className="space-y-2">
                    {condiciones
                      .filter((name) => toUpper(name).includes(toUpper(catalogSearch)))
                      .map((name) => (
                        <div key={name} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          <span className="text-xs font-bold text-slate-700">{name}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const confirmDelete = window.confirm(`Eliminar condicion: ${name}?`);
                              if (!confirmDelete) return;
                              setCondiciones(condiciones.filter((c) => c !== name));
                              enqueueWrite({ type: 'delete', collection: 'catalog_condiciones', id: toCatalogId(name) });
                            }}
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
      )
      }
    </div >
  );
};

// --- SMALL COMPONENTS ---
const NavItem = ({ active, icon, label, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-sm font-semibold ${active ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
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

const InputLabel = ({ label, className = '', ...props }) => (
  <div className="space-y-1">
    <label className="text-[10px] font-bold text-slate-500 uppercase">{label}</label>
    <input {...props} className={`w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium ${className}`} />
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

const Pagination = ({ page, totalPages, onPrev, onNext }) => (
  <div className="flex items-center justify-between px-6 py-3 text-xs text-slate-500 border-t border-slate-100">
    <span className="font-semibold">Pagina {page} de {totalPages}</span>
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 1}
        className="bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Anterior
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        className="bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Siguiente
      </button>
    </div>
  </div>
);

export default App;


