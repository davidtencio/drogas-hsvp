import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Lock,
  Package,
  PlusCircle,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { auth, db, googleProvider } from './firebase';
import { collection, doc, getCountFromServer, getDoc, getDocs, getDocsFromServer, limit, orderBy, query, setDoc, startAfter, where, writeBatch, deleteField } from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  parseDateTime,
  getTransactionTimestamp,
  getDisplayTimestamp,
  compareTransactionsAsc,
  compareTransactionsDesc,
  getLastBalanceAnchor,
  mergeTransactionsById,
  nextOpenRxUse,
  computeTotalReponer,
  computeMedStock,
  formatCurrency,
  parseCurrency,
  CLOSURE_24H_TURNO,
  isClosure24h,
  getClosureCutoffByMedId,
  mergeClosureCutoffs,
  isTransactionLocked,
  countLockedTransactions,
} from './utils/inventory';
import { getBackupChecksumSource, getBackupSummary } from './utils/backup';
import {
  allocateLotsFEFO,
  compareLotsFEFO,
  condenseLotsByIdentity,
  formatLotExpirationDate,
  formatLotTooltip,
  getAvailableLots,
  getDaysUntilExpiration,
  getLotInventorySummary,
  getLotOriginEditState,
  getLotUsage,
  isLotExpired,
  planLotCorrection,
  planLotRecount,
  summarizeLotIntegrityGate,
  validateLotEntry,
  validateLotInitialization,
} from './utils/lots';

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

const CLOSURE_LOCK_HINT =
  'Movimiento anterior a un CIERRE 24 HORAS: el periodo esta cerrado y el dato es inmutable.';

// Unicos campos que se pueden escribir sobre un movimiento ya congelado por un
// CIERRE 24 HORAS: anotaciones posteriores que no alteran cantidades ni saldos
// (verificacion cruzada y seguimiento de recetas abiertas). Debe mantenerse en
// sincronia con la lista equivalente de firestore.rules.
const CLOSURE_EDITABLE_FIELDS = [
  'crossCheckPharmacist',
  'crossCheckedAt',
  'rxUsed',
  'rxAdjusted',
  'rxAdjustedAt',
  'rxAdjustedBy',
  'rxAdjustedFrom',
];
const MED_TYPES = ['Estupefaciente', 'Psicotropico', 'Otros'];
const PAGE_SIZE = 25;
const CR_TIMEZONE = 'America/Costa_Rica';
const ENV_MAX_RECORDS = Number.parseInt(import.meta.env.VITE_MAX_RECORDS || '', 10);
const DEFAULT_MAX_RECORDS = Number.isFinite(ENV_MAX_RECORDS) && ENV_MAX_RECORDS > 0 ? ENV_MAX_RECORDS : 40000;
const INITIAL_CLOUD_LOAD = 200;
const LOAD_MORE_BATCH_SIZE = 200;
const SOFT_MEMORY_CAP_MULTIPLIER = 5;
const MAX_PENDING_WRITES = 200;
const MAX_SYNC_EVENTS = 200;
// Cache local (offline fallback): mantenemos solo los N mas recientes por coleccion
// para no saturar el cupo de localStorage (~5 MB). Firestore sigue siendo la fuente de verdad.
const LOCAL_CACHE_TX_LIMIT = 200;
const LOCAL_CACHE_EXP_LIMIT = 200;
const LOCAL_CACHE_BITACORA_LIMIT = 100;
const WRITE_BATCH_SIZE = 200;
const BACKUP_SCHEMA_VERSION = 3;
const QUOTA_EXCEEDED_ERRORS = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'];
const INITIAL_MEDICATIONS_BY_ID = new Map(INITIAL_MEDICATIONS.map((m) => [m.id, m]));
const RECOVERABLE_MED_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;
const AUTO_MED_NAME_PATTERN = /^MED\s+\d+$/i;
const getLotInitializationErrorMessage = (error = '') => {
  if (error.includes('INVALID_AMOUNT')) return 'Cada cantidad debe ser un numero entero mayor que cero.';
  if (error.includes('MISSING_LOT_NUMBER')) return 'Ingrese el numero de lote en todas las filas.';
  if (error.includes('INVALID_EXPIRATION_DATE')) return 'Ingrese una fecha de expiracion valida en todas las filas.';
  if (error.includes('DUPLICATE_LOT')) return 'No repita el mismo lote con la misma fecha de expiracion.';
  if (error === 'MISSING_LOTS') return 'Agregue al menos un lote para distribuir el saldo.';
  if (error === 'TOTAL_MISMATCH') return 'La suma de los lotes debe coincidir exactamente con el saldo.';
  return 'Revise la distribucion de lotes antes de continuar.';
};
const forceUppercaseInput = (event) => {
  event.currentTarget.value = event.currentTarget.value.toUpperCase();
};
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
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [lotInitializationByMedId, setLotInitializationByMedId] = useState({});
  const [lotInitializationMedId, setLotInitializationMedId] = useState('');
  const [lotInitializationTargetStock, setLotInitializationTargetStock] = useState(0);
  const [lotInitializationRows, setLotInitializationRows] = useState([]);
  const [lotInitializationPharmacist, setLotInitializationPharmacist] = useState('');
  const [lotInitializationSaving, setLotInitializationSaving] = useState(false);
  const [lotIntegrityAuditByMedId, setLotIntegrityAuditByMedId] = useState({});
  const [lotIntegrityVerifying, setLotIntegrityVerifying] = useState(false);
  const [lotExplorerMedId, setLotExplorerMedId] = useState(INITIAL_MEDICATIONS[0].id);
  const [lotExplorerResult, setLotExplorerResult] = useState(null);
  const [lotExplorerLoading, setLotExplorerLoading] = useState(false);
  const [lotExplorerShowDepleted, setLotExplorerShowDepleted] = useState(false);
  const [adjustLotMode, setAdjustLotMode] = useState('recuento');
  const [adjustLotContext, setAdjustLotContext] = useState(null);
  const [adjustLotRows, setAdjustLotRows] = useState([]);
  const [adjustLotLoading, setAdjustLotLoading] = useState(false);
  const [adjustLotSaving, setAdjustLotSaving] = useState(false);
  const [adjustCorrectionSourceId, setAdjustCorrectionSourceId] = useState('');
  const [adjustCorrectionLotNumber, setAdjustCorrectionLotNumber] = useState('');
  const [adjustCorrectionExpirationDate, setAdjustCorrectionExpirationDate] = useState('');
  const [totalTransactionsCount, setTotalTransactionsCount] = useState(0);
  // Cortes de cierre persistidos en Firestore (coleccion closureLocks): medId -> timestamp.
  // Son la fuente que tambien leen las reglas de seguridad; en pantalla se fusionan
  // con los cierres que esten cargados en memoria.
  const [closureLocksByMedId, setClosureLocksByMedId] = useState({});
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
  const [observationView, setObservationView] = useState(null);
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
  // Estado de la carga COMPLETA de movimientos por medicamento (where medId==X).
  // La carga global paginada por createdAt deja fuera rebajos con createdAt
  // desfasado; para el Kardex (que es por medicamento) cargamos todo el medicamento
  // y asi saldo, "X de Y" y el total del cierre quedan completos. medId -> estado.
  const [medLoadStatus, setMedLoadStatus] = useState({}); // 'loading' | 'complete' | 'error'
  const medLoadInFlightRef = useRef({});
  const pendingWritesRef = useRef([]);
  // Cortes de CIERRE 24 HORAS ya publicados en Firestore por el efecto de
  // retrocompatibilidad, y bandera para silenciarlo mientras el cierre de periodo
  // o una restauracion estan liberando candados (si volviera a publicarlos, las
  // reglas rechazarian el borrado del historial que esas operaciones deben purgar).
  const closureLockSyncRef = useRef({});
  const suppressClosureLockSyncRef = useRef(false);
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
    if (lotInitializationByMedId[medId]?.completed) {
      alert('El ajuste absoluto esta bloqueado para medicamentos con lotes inicializados. Registre una entrada o salida trazable para corregir el saldo.');
      return;
    }
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
    const okAdjust = enqueueWrite({ type: 'set', collection: 'transactions', id: newAdjustment.id, data: newAdjustment });
    if (!okAdjust) {
      notifyWriteFailed('el ajuste manual');
      return;
    }
    setTransactions([newAdjustment, ...transactions]);
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
  const downloadDatabaseBackup = async () => {
    if (!authUser || backupInProgress) return;
    if (pendingCount > 0) {
      alert('Sincronice los movimientos pendientes antes de generar un respaldo completo.');
      return;
    }
    setBackupInProgress(true);
    setCloudStatus('Generando respaldo completo...');
    try {
      const loadCompleteCollection = async (name) => {
        const snap = await getDocsFromServer(collection(db, dataDocPath, name));
        return snap.docs.map((item) => {
          const data = item.data();
          return { ...data, id: data.id ?? item.id };
        });
      };
      const [allTransactions, allExpedientes, allBitacora] = await Promise.all([
        loadCompleteCollection('transactions'),
        loadCompleteCollection('expedientes'),
        loadCompleteCollection('bitacora'),
      ]);
      const completeData = {
        medications,
        selectedMedId,
        maxRecords: maxRecordsLimit,
        services,
        pharmacists,
        condiciones,
        lotInitializationByMedId,
        transactions: allTransactions,
        expedientes: allExpedientes,
        bitacora: allBitacora,
      };
      const summary = getBackupSummary(completeData);
      const checksum = btoa(unescape(encodeURIComponent(getBackupChecksumSource(summary, selectedMedId, maxRecordsLimit))));
      const payload = {
        backupSchemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        orgId: ORG_ID,
        backupCoverage: {
          complete: true,
          source: 'firestore-server',
          collections: ['transactions', 'expedientes', 'bitacora'],
        },
        summary,
        checksum,
        data: completeData,
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
      setCloudStatus('Sincronizado');
    } catch (error) {
      console.error(error);
      setCloudStatus('Sin conexion');
      alert('No se pudo generar el respaldo completo desde Firestore. Revise la conexion e intente de nuevo.');
    } finally {
      setBackupInProgress(false);
    }
  };
  const downloadManualMarkdown = () => {
    const generatedAt = new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16);
    const stats = {
      medications: medications.length,
      transactions: transactions.length,
      expedientes: expedientes.length,
      bitacora: bitacora.length,
      services: services.length,
      pharmacists: pharmacists.length,
    };
    const md = `# Manual de Uso - Control de Drogas Hospitalizados

> Documento generado automaticamente el ${generatedAt} para servir de base en NotebookLM u otra herramienta de notebook.
> Datos actuales del sistema: ${stats.medications} medicamentos, ${stats.transactions} movimientos, ${stats.expedientes} expedientes, ${stats.bitacora} entradas de bitacora, ${stats.services} servicios, ${stats.pharmacists} farmaceuticos.

## 1. Que es la aplicacion

Sistema web del Servicio de Farmacia para el control centralizado de sustancias controladas (drogas/estupefacientes) en pacientes hospitalizados. Permite registrar ingresos y egresos, llevar un kardex por medicamento, validar la trazabilidad farmacoterapeutica contra expedientes/recetas y generar la documentacion para reposicion ante la autoridad reguladora.

Toda la informacion se sincroniza en la nube (Firebase) bajo la organizacion del centro de salud.

## 2. Conceptos clave

- **Medicamento / Sustancia controlada**: cada item del inventario con su nombre, identificador y saldo.
- **Saldo**: existencia disponible de un medicamento. Se calcula a partir de un saldo base ajustable mas los movimientos.
- **Movimiento (transaccion)**: ingreso (entrada de unidades) o egreso/rebajo (salida por dispensacion).
- **Kardex**: historial cronologico de movimientos de un medicamento, separado en Recientes e Historico segun la fecha.
- **Expediente / Receta**: respaldo clinico que justifica un egreso. Una receta puede estar abierta (en uso) o cerrada.
- **Cierre**: corte que consolida el inventario en un punto del tiempo.
- **Cierre 24 Horas**: cierre que ademas CIERRA EL PERIODO del medicamento. Todos sus movimientos anteriores (y el cierre mismo) quedan inmutables: no se pueden editar ni eliminar. El bloqueo es por medicamento, y lo posterior sigue siendo editable hasta el proximo cierre de 24 horas.
- **Farmaceutico**: responsable que firma cada operacion.

## 3. Modulos de la aplicacion

### 3.1 Dashboard (Resumen Operativo)
Vista general del estado del inventario: indicadores de uso, alertas y resumen de la operacion del dia. Punto de entrada para revisar rapidamente la situacion.

### 3.2 Kardex Individual (Kardex de Sustancias Controladas)
Historial detallado por medicamento. Muestra cada ingreso y egreso con fecha, cantidad, saldo resultante y farmaceutico responsable. Los registros se clasifican en **Recientes** e **Historico** segun su fecha visible. Se usa para auditar el movimiento de una sustancia especifica y verificar que el saldo cuadre.

Los movimientos alcanzados por un **CIERRE 24 HORAS** aparecen marcados como **CERRADO** con un candado y ya no ofrecen los botones Editar ni Eliminar: pertenecen a un periodo cerrado. Si hay que corregir algo de un periodo cerrado, se registra un movimiento nuevo o un ajuste de saldo en el periodo abierto; el historial cerrado no se reescribe. Sobre esos movimientos si se puede dejar el control cruzado y el seguimiento de recetas abiertas, porque son anotaciones que no alteran cantidades ni saldos.

### 3.3 Revisiones (Auditoria de Expedientes)
Validacion farmacoterapeutica: cruza los egresos contra los expedientes/recetas para confirmar que cada salida de sustancia controlada tenga respaldo. Permite detectar descuadres o registros sin justificacion.

### 3.4 Bitacora (Bitacora de Jornada)
Registro narrativo de la jornada: observaciones, incidencias y notas operativas del personal de guardia. Sirve como respaldo documental de lo ocurrido en cada turno.

### 3.5 Solicitud de Reposicion
Genera la solicitud para reponer existencias de sustancias controladas, consolidando los datos necesarios para el tramite ante la autoridad correspondiente.

### 3.6 Configuracion
Administracion del sistema:
- **Configuracion de Medicamentos**: renombrar medicamentos para corregir etiquetas y mostrar el nombre real en todo el sistema.
- **Uso de Registros**: monitorea cuantos registros se han usado contra el limite configurado y permite actualizar dicho limite.
- **Respaldo y Restauracion**: descargar la base completa en JSON, restaurar desde un archivo JSON y revisar la auditoria de restauraciones.
- **Ajuste Manual de Saldo**: corrige el saldo base de un medicamento; la app sigue calculando los movimientos a partir de ese ajuste.
- **Descargar Manual (Markdown)**: genera este documento.

## 4. Flujos de trabajo tipicos

### Registrar un egreso (dispensacion)
1. Seleccionar el medicamento.
2. Indicar la cantidad dispensada y el farmaceutico responsable.
3. Asociar el expediente/receta que respalda la salida.
4. Confirmar; el saldo se actualiza y queda en el kardex.

### Registrar un ingreso
1. Seleccionar el medicamento.
2. Indicar la cantidad recibida y el farmaceutico.
3. Confirmar; el saldo aumenta y el ingreso queda en el kardex.

### Cerrar / auditar
1. Revisar en Kardex que los saldos cuadren.
2. En Revisiones, validar que los egresos tengan expediente.
3. Registrar observaciones en la Bitacora.

### Reponer existencias
1. Ir a Solicitud de Reposicion.
2. Consolidar los medicamentos y cantidades a solicitar.
3. Generar la solicitud para el tramite.

## 5. Respaldo de datos
Desde Configuracion se puede **Descargar Base JSON** (respaldo completo) y **Cargar y Restaurar JSON**. Cada restauracion queda en la auditoria de restauraciones de la sesion. Se recomienda descargar el respaldo periodicamente.

## 6. Buenas practicas
- Verificar siempre el farmaceutico responsable antes de confirmar un movimiento.
- No registrar egresos sin su expediente/receta de respaldo.
- Revisar el indicador de Uso de Registros para no superar el limite.
- Usar el Ajuste Manual de Saldo solo para correcciones justificadas.
- Descargar respaldos JSON con regularidad.

---
*Manual base autogenerado. Editelo en su notebook para ampliarlo con capturas, ejemplos y politicas internas del servicio.*
`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `manual_drogas_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const downloadFentanylNotebookMarkdown = async () => {
    const fentanyl = medications.find((med) => /FENTAN(YL|ILO)/i.test(med.name || ''));
    if (!fentanyl) {
      alert('No se encontro fentanilo en el catalogo de medicamentos.');
      return;
    }

    let reportTransactions = transactions.filter((t) => t.medId === fentanyl.id);
    if (medLoadStatus[fentanyl.id] !== 'complete') {
      const loaded = await loadAllForMed(fentanyl.id);
      if (!Array.isArray(loaded)) {
        alert('No se pudo verificar el historial completo de fentanilo. Revise la conexion o el indice de Firestore e intente de nuevo.');
        return;
      }
      reportTransactions = mergeTransactionsById(reportTransactions, loaded).filter((t) => t.medId === fentanyl.id);
    }

    const ordered = reportTransactions.slice().sort(compareTransactionsAsc);
    const operational = ordered.filter((t) => !t.isCierre && t.affectsGlobalStock !== false);
    const inputs = operational.filter((t) => t.type === 'IN').reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const outputs = operational.filter((t) => t.type !== 'IN').reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const currentStock = (() => {
      const anchor = ordered.filter((t) => t.isCierre).sort(compareTransactionsDesc)[0];
      const anchorTime = anchor ? getTransactionTimestamp(anchor) : null;
      return operational
        .filter((t) => anchorTime === null || getTransactionTimestamp(t) > anchorTime)
        .reduce(
          (stock, t) => stock + (t.type === 'IN' ? Number(t.amount) || 0 : -(Number(t.amount) || 0)),
          Number(anchor?.totalMedicamento) || 0,
        );
    })();
    const escapeMd = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '—';
    const rows = ordered.map((t) => {
      const movementType = t.isCierre ? (t.isManualAdjustment ? 'AJUSTE DE SALDO' : 'CIERRE') : t.type === 'IN' ? 'INGRESO' : 'EGRESO';
      const quantity = t.isCierre ? (t.totalMedicamento ?? t.amount ?? '') : t.amount;
      return `| ${escapeMd(t.date)} | ${movementType} | ${escapeMd(quantity)} | ${escapeMd(t.service)} | ${escapeMd(t.cama)} | ${escapeMd(t.prescription)} | ${escapeMd(t.dosis)} | ${escapeMd(t.rxType)} | ${escapeMd(t.observacion)} | ${escapeMd(t.pharmacist)} |`;
    });
    const generatedAt = new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16);
    const firstDate = ordered[0]?.date || 'Sin movimientos';
    const lastDate = ordered[ordered.length - 1]?.date || 'Sin movimientos';
    const md = `# Informe de movimientos de ${escapeMd(fentanyl.name)}

> Fuente: Control de Drogas Hospitalizados (HSVP).
> Generado el ${generatedAt}, zona horaria America/Costa_Rica.
> Historial completo verificado al momento de la descarga.

## Resumen

- Medicamento: **${escapeMd(fentanyl.name)}**
- Identificador interno: **${escapeMd(fentanyl.id)}**
- Periodo registrado: **${escapeMd(firstDate)} a ${escapeMd(lastDate)}**
- Registros incluidos: **${ordered.length}**
- Total de ingresos: **${inputs} unidades**
- Total de egresos: **${outputs} unidades**
- Saldo calculado actual: **${currentStock} unidades**

## Movimientos

| Fecha | Tipo | Cantidad / saldo | Servicio | Cama | Receta | Dosis | Tipo de receta | Observacion | Farmaceutico |
|---|---|---:|---|---|---|---|---|---|---|
${rows.length ? rows.join('\n') : '| — | SIN MOVIMIENTOS | — | — | — | — | — | — | — | — |'}

## Notas para el analisis

- Los ingresos aumentan el inventario y los egresos lo disminuyen.
- Los cierres y ajustes de saldo son anclas de inventario; su cantidad representa el saldo consolidado, no una entrada ni una salida.
- Un CIERRE 24 HORAS cierra el periodo del medicamento: los movimientos hasta esa fecha son inmutables y no pueden haber sido alterados despues.
- Este archivo Markdown esta estructurado para utilizarse como fuente en NotebookLM.
`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `informe_fentanilo_notebooklm_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  // El cierre de periodo y la restauracion reconstruyen la base completa, asi que
  // necesitan purgar tambien historial cerrado. Para poder hacerlo liberan antes
  // los candados, dejando registrado el motivo y la fecha (las reglas de Firestore
  // exigen esos campos para aceptar que un corte baje).
  const resetClosureLocks = async (reason) => {
    suppressClosureLockSyncRef.current = true;
    const snap = await getDocs(collection(db, dataDocPath, 'closureLocks'));
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach((docSnap) => {
        batch.set(
          docSnap.ref,
          { cutoff: 0, reset: true, resetReason: reason, resetAt: Date.now() },
          { merge: true },
        );
      });
      await batch.commit();
    }
    closureLockSyncRef.current = {};
    setClosureLocksByMedId({});
    logSyncEvent('closure_locks_reset', reason);
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
      const incomingLotInitializationByMedId =
        data.lotInitializationByMedId && typeof data.lotInitializationByMedId === 'object'
          ? data.lotInitializationByMedId
          : {};
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

      // La restauracion reemplaza la base entera, incluido el historial cerrado:
      // libera los candados para poder borrarlo. Los cierres que traiga el respaldo
      // vuelven a publicar su propio corte al cargarse.
      await resetClosureLocks(`restauracion:${file.name}`);
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
          lotInitializationByMedId: incomingLotInitializationByMedId,
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
      setLotInitializationByMedId(incomingLotInitializationByMedId);
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
      // Se rehabilita la publicacion de candados: los cierres que traiga el
      // respaldo restaurado deben volver a establecer su propio corte.
      suppressClosureLockSyncRef.current = false;
      if (restoreInputRef.current) restoreInputRef.current.value = '';
    }
  };

  const getRxProgress = (t) => {
    if (t.rxType !== 'ABIERTA') return '';
    const matches = transactions
      .filter(
        (x) =>
          x.medId === t.medId &&
          x.prescription === t.prescription &&
          x.type === 'OUT' &&
          x.rxType === 'ABIERTA' &&
          x.rxQuantity === t.rxQuantity,
      )
      .slice()
      .sort(compareTransactionsAsc);
    let used = 0;
    for (const item of matches) {
      used += Number(item.amount) || 0;
      if (item.rxAdjusted) {
        used = Number(item.rxUsed) || used;
      }
      if (item.id === t.id) break;
    }
    used = Math.min(used, Number(t.rxQuantity) || 0);
    return `${used} de ${t.rxQuantity}`;
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

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      // Autopurga: el cache pharmaControlData es redundante con Firestore.
      // Solo lo borramos si el escritor actual NO es pharmaControlData (si no, abajo cae al fallback igual).
      if (key !== 'pharmaControlData') {
        try { localStorage.removeItem('pharmaControlData'); } catch { /* noop */ }
        try {
          localStorage.setItem(key, value);
          setSyncEvents((prev) => [
            {
              at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
              type: 'quota_autopurge',
              detail: `Purgado pharmaControlData para liberar espacio (key=${key}).`,
            },
            ...prev,
          ].slice(0, MAX_SYNC_EVENTS));
          return true;
        } catch { /* sigue lleno: bloqueamos abajo */ }
      }
      try {
        localStorage.removeItem(key);
      } catch {
        // Ignorar errores de limpieza.
      }
      // Cualquier key que llegue aqui implica que ya no podemos persistir.
      // Bloqueamos escrituras y avisamos. Esto incluye pharmaControlData,
      // porque si ese key no se puede guardar el cache local quedo inconsistente.
      setWriteBlockedByStorage(true);
      if (key === 'pharmaPendingWrites') setQueueOverflow(true);
      setSyncError(
        key === 'pharmaPendingWrites'
          ? 'Cola offline sin espacio: nuevas escrituras bloqueadas hasta sincronizar/liberar espacio.'
          : 'Sin espacio en almacenamiento local: nuevas escrituras bloqueadas hasta liberar espacio.',
      );
      setSyncEvents((prev) => [
        {
          at: new Date().toLocaleString('es-CR', { hour12: false, timeZone: CR_TIMEZONE }).slice(0, 16),
          type: 'blocked_by_quota',
          detail: `Sin espacio en almacenamiento local (key=${key}).`,
        },
        ...prev,
      ].slice(0, MAX_SYNC_EVENTS));
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

  const handleOpenRxUse = async (transaction, overridePharmacist, overrideAmount) => {
    if (transaction.rxType !== 'ABIERTA' || transaction.rxQuantity <= 0) return;
    const amountToUse = parseInt(overrideAmount, 10);
    if (!Number.isFinite(amountToUse) || amountToUse <= 0) return;
    const proceed = await confirmIfNegativeStock(transaction.medId, amountToUse);
    if (!proceed) return;
    const lotAllocations = await prepareLotAllocations(transaction.medId, amountToUse);
    if (!lotAllocations) return;
    const nextUsed = nextOpenRxUse(
      transactions,
      transaction.medId,
      transaction.prescription,
      transaction.rxQuantity,
      amountToUse,
    );
    if (nextUsed <= transaction.rxUsed) return;
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
      lotAllocations,
      rxUsed: nextUsed,
      pharmacist: toUpper(overridePharmacist || transaction.pharmacist),
    };
    const okOpenRx = enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
    if (!okOpenRx) {
      notifyWriteFailed('el rebajo');
      return;
    }
    setTransactions([newTransaction, ...transactions]);
  };

  // Un movimiento congelado admite unicamente anotaciones que no alteran
  // cantidades ni saldos: la verificacion cruzada y el seguimiento de recetas
  // abiertas. Cualquier otro campo (amount, medId, lote, fecha, totalMedicamento)
  // queda bloqueado. Esta lista debe coincidir con la de firestore.rules.
  const getChangedFields = (before, patch) =>
    Object.keys(patch || {}).filter(
      (key) => JSON.stringify(before?.[key]) !== JSON.stringify(patch[key]),
    );

  const notifyClosureLocked = (label) => {
    alert(
      `No se puede ${label}.\n\n` +
      'El movimiento es anterior a un CIERRE 24 HORAS y el periodo ya esta cerrado.\n' +
      'Los datos cerrados son inmutables: registre un movimiento nuevo o un ajuste de saldo.',
    );
  };

  const notifyWriteFailed = (label) => {
    alert(
      `No se pudo guardar ${label || 'el registro'}.\n\n` +
      'Almacenamiento local lleno o sincronizacion bloqueada.\n' +
      'Sincronice pendientes o libere espacio antes de continuar.',
    );
  };

  const enqueueWrite = (action) => {
    if (writeBlockedByStorage) {
      setSyncError('Escritura bloqueada: libere espacio local o sincronice pendientes.');
      logSyncEvent('enqueue_blocked', `${action.collection}/${action.id}`);
      return false;
    }
    // Inmutabilidad del periodo cerrado. Se valida aqui, y no solo ocultando
    // botones, porque enqueueWrite es el paso obligatorio de toda escritura:
    // asi ninguna ruta de la app puede tocar un movimiento congelado por error.
    if (action.collection === 'transactions') {
      const existing = transactions.find((t) => String(t.id) === String(action.id));
      // Si el movimiento aun no existe es un alta: nunca esta congelado.
      if (existing && isLockedTransaction(existing)) {
        if (action.type === 'delete') {
          logSyncEvent('closure_locked', `delete transactions/${action.id}`);
          notifyClosureLocked('eliminar este movimiento');
          return false;
        }
        const changed = getChangedFields(existing, action.data);
        const forbidden = changed.filter((key) => !CLOSURE_EDITABLE_FIELDS.includes(key));
        if (forbidden.length > 0) {
          logSyncEvent('closure_locked', `set transactions/${action.id} campos=${forbidden.join(',')}`);
          notifyClosureLocked('modificar este movimiento');
          return false;
        }
      }
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
    if (!ok) return false;
    if (action.collection === 'transactions' && action.data?.medId) {
      setLotIntegrityAuditByMedId((previous) => {
        if (!previous[action.data.medId]) return previous;
        const nextAudit = { ...previous };
        delete nextAudit[action.data.medId];
        return nextAudit;
      });
    }
    logSyncEvent('enqueue', `${enriched.type} ${enriched.collection}/${enriched.id}`);
    if (!authUser) return true;
    flushWriteQueue();
    return true;
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
    // flushWriteQueue se redefine en cada render; agregarla causaria bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          if (data.lotInitializationByMedId && typeof data.lotInitializationByMedId === 'object') {
            setLotInitializationByMedId(data.lotInitializationByMedId);
          }
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
        // Cortes de CIERRE 24 HORAS. Se cargan completos (uno por medicamento) para
        // que el bloqueo funcione aunque el cierre no entre en la ventana inicial
        // de movimientos: sin esto, un cierre viejo pasaria desapercibido en pantalla.
        try {
          const locksSnap = await getDocs(collection(db, dataDocPath, 'closureLocks'));
          const locks = {};
          locksSnap.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const cutoff = Number(data?.cutoff);
            if (Number.isFinite(cutoff)) locks[data?.medId || docSnap.id] = cutoff;
          });
          if (!cancelled) setClosureLocksByMedId(locks);
        } catch (error) {
          console.error('No se pudieron cargar los cierres de 24 horas', error);
        }
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
          if (stored.lotInitializationByMedId && typeof stored.lotInitializationByMedId === 'object') {
            setLotInitializationByMedId(stored.lotInitializationByMedId);
          }
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
    // Hidratacion intencional solo al cambiar de usuario; resto de deps son estables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Carga TODOS los movimientos de un medicamento (where medId==X) y los fusiona
  // en `transactions`. Garantiza que el Kardex de ese medicamento sea completo:
  // saldo, "X de Y" y el total del cierre dejan de depender de la ventana global
  // de 200 por createdAt. Requiere indice Firestore (medId + createdAt desc).
  const loadAllForMed = async (medId) => {
    if (!authUser || !cloudReady || !medId) return;
    if (medLoadInFlightRef.current[medId]) return;
    medLoadInFlightRef.current[medId] = true;
    setMedLoadStatus((prev) => ({ ...prev, [medId]: 'loading' }));
    try {
      const colRef = collection(db, dataDocPath, 'transactions');
      const collected = [];
      let lastDoc = null;
      for (;;) {
        const q = lastDoc
          ? query(colRef, where('medId', '==', medId), orderBy('createdAt', 'desc'), startAfter(lastDoc), limit(500))
          : query(colRef, where('medId', '==', medId), orderBy('createdAt', 'desc'), limit(500));
        const snap = await getDocs(q);
        if (snap.empty) break;
        collected.push(...snap.docs.map((d) => d.data()));
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < 500) break;
        await delay(50);
      }
      setTransactions((prev) => mergeTransactionsById(prev, collected));
      setMedLoadStatus((prev) => ({ ...prev, [medId]: 'complete' }));
      logSyncEvent('med_full_load', `medId=${medId} items=${collected.length}`);
      return collected;
    } catch (error) {
      setMedLoadStatus((prev) => ({ ...prev, [medId]: 'error' }));
      setSyncError(
        'No se pudo cargar el historial completo del medicamento (falta indice Firestore medId+createdAt o error de conexion).',
      );
      logSyncEvent('med_full_load_error', `medId=${medId} code=${error?.code || 'unknown'}`);
      return null;
    } finally {
      medLoadInFlightRef.current[medId] = false;
    }
  };

  // Al entrar al Kardex o cambiar de medicamento, asegurar su carga completa.
  // Solo se dispara cuando el medicamento no tiene estado todavia (undefined).
  // 'error' es terminal para el auto-reintento (evita un bucle si falta el
  // indice Firestore); se reintenta con el boton "Reintentar" o recargando.
  useEffect(() => {
    if (!authUser || !cloudReady || activeTab !== 'kardex' || !selectedMedId) return;
    if (medLoadStatus[selectedMedId]) return;
    loadAllForMed(selectedMedId);
    // loadAllForMed se redefine en cada render; incluirla causaria bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, cloudReady, activeTab, selectedMedId, medLoadStatus]);

  useEffect(() => {
    if (!authUser || !cloudReady) return;
    if (!kardexSearch.trim()) return;
    if (!collectionLoadState.transactions.hasMore || collectionLoadState.transactions.loading) return;
    loadMoreCollection('transactions', setTransactions);
    // loadMoreCollection se redefine en cada render; incluirla causaria bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Trim para no saturar localStorage. Firestore es la fuente de verdad.
    const localPayload = {
      transactions: transactions.slice(0, LOCAL_CACHE_TX_LIMIT),
      expedientes: expedientes.slice(0, LOCAL_CACHE_EXP_LIMIT),
      bitacora: bitacora.slice(0, LOCAL_CACHE_BITACORA_LIMIT),
      medications,
      services,
      pharmacists,
      condiciones,
      selectedMedId,
      maxRecords: maxRecordsLimit,
      lotInitializationByMedId,
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
      lotInitializationByMedId,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medications, selectedMedId, maxRecordsLimit, lotInitializationByMedId, cloudReady, authUser, syncError]);

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
    // El arrastre de saldos usa currentInventory (todos los medicamentos). Si la
    // carga global esta incompleta, arrastrariamos saldos parciales y erroneos.
    // Mejor posponer el rollover hasta tener el historial completo cargado.
    if (collectionLoadState.transactions.hasMore) {
      logSyncEvent('rollover_postponed', 'historial global incompleto (hasMore=true)');
      return;
    }
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
      // Usar el MISMO stock que muestra el inventario (currentInventory), que parte
      // de la ultima ancla de saldo (cierres y ajustes manuales) y suma los
      // movimientos posteriores. Recalcular desde cero ignorando las anclas
      // descuadraria el saldo de arrastre cuando existe un ajuste manual o un
      // cierre cuyo totalMedicamento no es la suma pura de entradas-salidas.
      const stockByMedId = new Map(currentInventory.map((m) => [m.id, m.stock]));
      const carryOverTransactions = sortedMedications.map(med => {
        const stock = Number(stockByMedId.get(med.id)) || 0;

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

      // El respaldo ya se descargo arriba: recien ahi se liberan los candados de
      // CIERRE 24 HORAS, que es lo que permite purgar tambien el historial cerrado.
      await resetClosureLocks('cierre_periodo');
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
      // Tras la purga los saldos de arrastre son posteriores a cualquier corte, asi
      // que rehabilitar la publicacion de candados no vuelve a congelar nada. Importa
      // sobre todo en la rama de error, donde no hay recarga de pagina.
      suppressClosureLockSyncRef.current = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          t.affectsGlobalStock !== false &&
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
      // Clasificacion por fecha MOSTRADA (date), no por createdAt: un movimiento
      // con fecha visible reciente no debe quedar oculto en el historico aunque
      // su createdAt este desfasado. El orden dentro de cada tabla y el calculo
      // de saldo siguen usando createdAt (compareTransactionsDesc / kardexBalanceById).
      const whenTs = getDisplayTimestamp(t);
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
      if (t.isCierre) {
        running = Number(t.totalMedicamento) || 0;
      } else if (t.affectsGlobalStock !== false) {
        const amount = Number(t.amount) || 0;
        running += t.type === 'IN' ? amount : -amount;
      }
      balanceMap[t.id] = running;
    });
    return balanceMap;
     
  }, [transactions, selectedMedId]);
  // Progreso "X de Y" de recetas ABIERTAS precalculado en una sola pasada.
  // Antes se computaba por fila con un filter+sort sobre todas las transacciones
  // (O(n^2) en el render del Kardex); ahora se agrupa una vez por (receta, cantidad).
  const rxProgressById = useMemo(() => {
    const groups = new Map();
    transactions
      .filter(
        (t) =>
          t.medId === selectedMedId &&
          t.type === 'OUT' &&
          t.rxType === 'ABIERTA',
      )
      .slice()
      .sort(compareTransactionsAsc)
      .forEach((t) => {
        const key = `${t.prescription}|${t.rxQuantity}`;
        const group = groups.get(key) || [];
        group.push(t);
        groups.set(key, group);
      });
    const progressMap = {};
    groups.forEach((items) => {
      let used = 0;
      items.forEach((t) => {
        used += Number(t.amount) || 0;
        if (t.rxAdjusted) {
          used = Number(t.rxUsed) || used;
        }
        const capped = Math.min(used, Number(t.rxQuantity) || 0);
        progressMap[t.id] = `${capped} de ${t.rxQuantity}`;
      });
    });
    return progressMap;
     
  }, [transactions, selectedMedId]);
  const totalReponerByCierreId = useMemo(() => {
    const medItems = transactions
      .filter((t) => t.medId === selectedMedId)
      .slice()
      .sort(compareTransactionsAsc);
    const map = {};
    const selectedMedication = medications.find((m) => m.id === selectedMedId);
    const quota = Number(selectedMedication?.quota) || 0;
    medItems.forEach((t) => {
      if (!isClosure24h(t)) return;
      const currentStockAtClose = Number(t.totalMedicamento) || 0;
      map[t.id] = computeTotalReponer(quota, currentStockAtClose);
    });
    return map;

  }, [transactions, selectedMedId, medications]);
  // Corte de inmutabilidad por medicamento. Un CIERRE 24 HORAS congela todo el
  // historial de SU medicamento hasta ese instante (incluido el cierre mismo):
  // no se puede editar ni eliminar. Lo posterior sigue siendo editable hasta el
  // proximo cierre de 24 horas.
  const closureCutoffByMedId = useMemo(
    () => mergeClosureCutoffs(getClosureCutoffByMedId(transactions), closureLocksByMedId),
    [transactions, closureLocksByMedId],
  );
  const isLockedTransaction = useCallback(
    (t) => isTransactionLocked(t, closureCutoffByMedId),
    [closureCutoffByMedId],
  );
  // Retrocompatibilidad: los cierres de 24 horas registrados antes de esta version
  // no dejaron candado en Firestore, y sin el las reglas de seguridad no tienen
  // con que bloquear. Cuando aparece un cierre cuyo corte supera al persistido, se
  // publica el candado. El ref evita reencolar el mismo valor en cada render.
  useEffect(() => {
    if (!authUser || suppressClosureLockSyncRef.current) return;
    const computed = getClosureCutoffByMedId(transactions);
    Object.entries(computed).forEach(([medId, cutoff]) => {
      const stored = Number(closureLocksByMedId[medId]);
      if (Number.isFinite(stored) && stored >= cutoff) return;
      if (Number(closureLockSyncRef.current[medId]) >= cutoff) return;
      closureLockSyncRef.current[medId] = cutoff;
      const ok = enqueueWrite({
        type: 'set',
        collection: 'closureLocks',
        id: medId,
        data: { id: medId, medId, cutoff, updatedAt: Date.now(), updatedBy: 'BACKFILL', reset: false },
      });
      if (ok) setClosureLocksByMedId((prev) => ({ ...prev, [medId]: cutoff }));
    });
    // enqueueWrite se redefine en cada render; depender de el reejecutaria el efecto
    // sin necesidad. El ref ya garantiza que cada corte se publique una sola vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, closureLocksByMedId, authUser]);
  // pendingCount es el trigger intencional: cuando cambia, recomputamos el set
  // a partir del ref (que no es reactivo). Es un patron deliberado.
  const pendingWriteKeySet = useMemo(() => {
    const set = new Set();
    (pendingWritesRef.current || []).forEach((w) => {
      set.add(`${w.collection}:${String(w.id)}`);
    });
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const integrityGate = summarizeLotIntegrityGate(medications, lotInitializationByMedId, lotIntegrityAuditByMedId);
    const allInitialized = medications.length > 0 && integrityGate.pending.length === 0;
    const checks = [
      { key: 'no_pending', label: 'Sin pendientes de sincronizacion', ok: !hasPending },
      { key: 'no_sync_error', label: 'Sin errores activos de sincronizacion', ok: !hasSyncError },
      { key: 'no_queue_risk', label: 'Sin riesgo de cola local', ok: !hasQueueRisk },
      { key: 'recent_backup', label: 'Respaldo verificado en sesion', ok: hasRecentBackup },
      {
        key: 'all_initialized',
        label: 'Todos los medicamentos inicializados',
        ok: allInitialized,
        details: allInitialized
          ? []
          : integrityGate.details.filter((line) => line.startsWith('Sin inicializar') || line.startsWith('No hay')),
      },
      {
        key: 'lot_integrity',
        label: 'Saldo global coincide con existencias por lote',
        ok: integrityGate.ok,
        details: integrityGate.details,
      },
    ];
    return {
      checks,
      approved: checks.every((c) => c.ok),
    };
  }, [pendingCount, syncError, queueOverflow, writeBlockedByStorage, backupAuditLog, medications, lotInitializationByMedId, lotIntegrityAuditByMedId]);
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
      if (!isClosure24h(t)) return;
      const medId = t.medId;
      if (!medId) return;
      const ts = getTransactionTimestamp(t);
      const quota = quotaByMedId.get(medId) || 0;
      const currentStockAtClose = Number(t.totalMedicamento) || 0;
      const totalReponer = computeTotalReponer(quota, currentStockAtClose);
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
  // Opcion B (#5): no bloquear el egreso, pero advertir si deja el saldo en
  // negativo. La confirmacion solo aparece cuando amount > stock disponible,
  // para no generar fatiga de clics en los rebajos normales.
  const confirmIfNegativeStock = async (medId, amount) => {
    const available = Number(currentInventory.find((m) => m.id === medId)?.stock) || 0;
    if (amount <= available) return true;
    const medName = medications.find((m) => m.id === medId)?.name || medId;
    return requestStyledConfirm(
      `Esta salida deja ${medName} en ${available - amount} (saldo actual ${available}, salida ${amount}). ¿Desea continuar?`,
    );
  };

  const prepareLotAllocations = async (medId, amount, excludedTransactionId = null) => {
    if (!lotInitializationByMedId[medId]?.completed) {
      // Migracion gradual: los medicamentos aun no conciliados mantienen el
      // flujo historico. En cuanto uno se inicializa, FEFO se vuelve obligatorio
      // para todas sus salidas. El bloqueo global corresponde al gate de fase 5.
      return [];
    }
    setCloudStatus('Verificando lotes FEFO...');
    const loaded = await loadAllForMed(medId);
    if (!Array.isArray(loaded)) {
      setCloudStatus('Sin conexion');
      alert('No se pudo verificar el historial completo de lotes. Intente de nuevo.');
      return null;
    }
    const completeTransactions = mergeTransactionsById(transactions, loaded).filter(
      (transaction) => excludedTransactionId === null || String(transaction.id) !== String(excludedTransactionId),
    );
    const allocation = allocateLotsFEFO(completeTransactions, medId, amount);
    setCloudStatus('Sincronizado');
    if (!allocation.ok) {
      if (allocation.code === 'INVALID_AMOUNT') {
        alert('La cantidad de la salida debe ser un entero mayor que cero.');
      } else {
        alert(
          `No hay existencias suficientes en lotes vigentes. Disponible: ${allocation.availableQuantity}; solicitado: ${allocation.requestedQuantity}. ` +
            'Revise la inicializacion, los ingresos o los lotes vencidos.',
        );
      }
      return null;
    }
    return allocation.allocations;
  };

  const verifyLotIntegrity = async (medId, { notify = true } = {}) => {
    if (!lotInitializationByMedId[medId]?.completed) {
      if (notify) alert('Inicialice los lotes de este medicamento antes de verificar su integridad.');
      return null;
    }
    setCloudStatus('Verificando integridad de lotes...');
    const loaded = await loadAllForMed(medId);
    if (!Array.isArray(loaded)) {
      setCloudStatus('Sin conexion');
      if (notify) alert('No se pudo cargar el historial completo para verificar los lotes.');
      return null;
    }
    const completeTransactions = mergeTransactionsById(transactions, loaded).filter((item) => item.medId === medId);
    const globalStock = computeMedStock(completeTransactions, medId);
    const lotSummary = getLotInventorySummary(completeTransactions, medId);
    const result = {
      verifiedAt: new Date().toISOString(),
      globalStock,
      lotStock: lotSummary.totalAvailable,
      usableStock: lotSummary.usableAvailable,
      expiredStock: lotSummary.expiredAvailable,
      lotCount: lotSummary.lotCount,
      match: globalStock === lotSummary.totalAvailable,
    };
    setLotIntegrityAuditByMedId((previous) => ({ ...previous, [medId]: result }));
    setCloudStatus('Sincronizado');
    if (notify) {
      alert(
        result.match
          ? `Integridad correcta. Saldo global y lotes: ${globalStock}. Vigente: ${result.usableStock}; vencido: ${result.expiredStock}.`
          : `Descuadre detectado. Saldo global: ${globalStock}; existencias por lote: ${result.lotStock}.`,
      );
    }
    return result;
  };

  const verifyAllLotIntegrity = async () => {
    if (lotIntegrityVerifying) return;
    const initialized = medications.filter((med) => lotInitializationByMedId[med.id]?.completed);
    if (initialized.length === 0) {
      alert('Todavia no hay medicamentos inicializados para verificar.');
      return;
    }
    setLotIntegrityVerifying(true);
    const mismatches = [];
    try {
      for (const med of initialized) {
        const result = await verifyLotIntegrity(med.id, { notify: false });
        if (!result?.match) {
          mismatches.push(
            result
              ? `${med.name}: saldo global ${result.globalStock} vs lotes ${result.lotStock}`
              : `${med.name}: no se pudo verificar`,
          );
        }
      }
      alert(
        mismatches.length === 0
          ? `Integridad verificada en ${initialized.length} medicamento(s).`
          : `Verificacion terminada con ${mismatches.length} medicamento(s) descuadrado(s):\n\n${mismatches.join('\n')}`,
      );
    } finally {
      setLotIntegrityVerifying(false);
    }
  };

  // Consulta de solo lectura: carga el historial COMPLETO del medicamento antes
  // de calcular el detalle por lote. Con la carga parcial del Kardex quedarian
  // rebajos fuera y el disponible por lote saldria inflado.
  const loadLotExplorer = async (medId) => {
    if (!medId || lotExplorerLoading) return;
    setLotExplorerLoading(true);
    setCloudStatus('Consultando lotes disponibles...');
    try {
      const loaded = await loadAllForMed(medId);
      if (!Array.isArray(loaded)) {
        setCloudStatus('Sin conexion');
        alert('No se pudo cargar el historial completo del medicamento para listar sus lotes. Intente de nuevo.');
        return;
      }
      const completeTransactions = mergeTransactionsById(transactions, loaded).filter((item) => item.medId === medId);
      const summary = getLotInventorySummary(completeTransactions, medId);
      setLotExplorerResult({
        medId,
        medName: medications.find((med) => med.id === medId)?.name || medId,
        consultedAt: new Date().toISOString(),
        globalStock: computeMedStock(completeTransactions, medId),
        initialized: Boolean(lotInitializationByMedId[medId]?.completed),
        lots: [...summary.lots].sort(compareLotsFEFO),
        lotCount: summary.lotCount,
        totalAvailable: summary.totalAvailable,
        usableAvailable: summary.usableAvailable,
        expiredAvailable: summary.expiredAvailable,
      });
      setCloudStatus('Sincronizado');
    } finally {
      setLotExplorerLoading(false);
    }
  };

  // Carga el estado real de lotes del medicamento para poder ajustarlo. Precarga
  // el recuento con lo que hay hoy: lo normal es corregir una cantidad o una
  // fecha puntual, no redigitar todo el inventario.
  const loadAdjustLotContext = async (medId) => {
    if (!medId || adjustLotLoading) return null;
    if (pendingCount > 0) {
      alert('Sincronice los movimientos pendientes antes de ajustar lotes.');
      return null;
    }
    setAdjustLotLoading(true);
    setCloudStatus('Cargando existencias por lote...');
    try {
      const loaded = await loadAllForMed(medId);
      if (!Array.isArray(loaded)) {
        setCloudStatus('Sin conexion');
        alert('No se pudo cargar el historial completo del medicamento. Intente de nuevo.');
        return null;
      }
      const completeTransactions = mergeTransactionsById(transactions, loaded).filter((item) => item.medId === medId);
      const lots = getAvailableLots(completeTransactions, medId, { includeExpired: true });
      // El recuento se declara por lote fisico: un mismo lote ingresado en varias
      // fechas es una sola fila. Los origenes sin condensar quedan en `lots` para
      // la correccion, que si apunta a un ingreso puntual.
      const condensedLots = condenseLotsByIdentity(lots);
      const context = {
        medId,
        medName: medications.find((med) => med.id === medId)?.name || medId,
        loadedAt: new Date().toISOString(),
        globalStock: computeMedStock(completeTransactions, medId),
        lotStock: lots.reduce((sum, lot) => sum + lot.availableQuantity, 0),
        lots,
        condensedCount: condensedLots.length,
      };
      setAdjustLotContext(context);
      setAdjustLotRows(
        condensedLots.map((lot) => ({
          lotNumber: lot.lotNumber,
          expirationDate: lot.expirationDate,
          quantity: String(lot.quantity),
        })),
      );
      setAdjustCorrectionSourceId(lots[0]?.sourceTransactionId || '');
      setAdjustCorrectionLotNumber(lots[0]?.lotNumber || '');
      setAdjustCorrectionExpirationDate(lots[0]?.expirationDate || '');
      setCloudStatus('Sincronizado');
      return context;
    } finally {
      setAdjustLotLoading(false);
    }
  };

  const resetAdjustLotState = () => {
    setAdjustLotContext(null);
    setAdjustLotRows([]);
    setAdjustCorrectionSourceId('');
    setAdjustCorrectionLotNumber('');
    setAdjustCorrectionExpirationDate('');
  };

  const invalidateLotIntegrity = (medId) => {
    setLotIntegrityAuditByMedId((previous) => {
      if (!previous[medId]) return previous;
      const next = { ...previous };
      delete next[medId];
      return next;
    });
  };

  // Recuento fisico: la suma de los lotes declarados pasa a ser el saldo. Se
  // escribe en un solo batch la liberacion de lo anterior, los lotes nuevos y el
  // ancla de saldo, para que global y lotes nunca queden desalineados a medias.
  const applyLotRecount = async () => {
    const medId = adjustLotContext?.medId;
    if (!medId || adjustLotSaving) return;
    if (!lotInitializationByMedId[medId]?.completed) return;
    if (pendingCount > 0) {
      alert('Sincronice los movimientos pendientes antes de ajustar lotes.');
      return;
    }
    const pharmacist = toUpper(adjustPharmacist || pharmacists[0] || '');
    if (!pharmacist) {
      alert('Seleccione el farmaceutico responsable.');
      return;
    }
    const draftPlan = planLotRecount(
      mergeTransactionsById(transactions, []).filter((item) => item.medId === medId),
      medId,
      adjustLotRows,
    );
    if (!draftPlan.valid) {
      alert(getLotInitializationErrorMessage(draftPlan.errors[0] || ''));
      return;
    }
    const expiredRows = draftPlan.rows.filter((row) => isLotExpired(row.expirationDate));
    if (expiredRows.length > 0) {
      const proceedExpired = await requestStyledConfirm(
        `El recuento incluye ${expiredRows.length} lote(s) vencido(s). Quedaran registrados para trazabilidad, pero no se usaran en egresos automaticos. ¿Desea continuar?`,
      );
      if (!proceedExpired) return;
    }
    const confirmed = await requestStyledConfirm(
      draftPlan.rows.length === 0
        ? `Confirme llevar ${adjustLotContext.medName} a CERO. Se liberaran ${draftPlan.currentLotStock} unidad(es) en ${draftPlan.releaseAllocations.length} lote(s) y el saldo quedara en 0.`
        : `Confirme el recuento de ${adjustLotContext.medName}: ${draftPlan.newTotal} unidad(es) en ${draftPlan.rows.length} lote(s). El saldo pasara de ${adjustLotContext.globalStock} a ${draftPlan.newTotal}.`,
    );
    if (!confirmed) return;
    const authorized = await requestSecurityKey();
    if (!authorized) return;
    setAdjustLotSaving(true);
    setCloudStatus('Aplicando recuento de lotes...');
    try {
      // Reverificacion contra Firestore: la app esta en uso real y un egreso
      // registrado mientras se contaba invalidaria el recuento.
      const latestLoaded = await loadAllForMed(medId);
      if (!Array.isArray(latestLoaded)) throw new Error('No se pudo reverificar el estado de lotes.');
      const completeTransactions = mergeTransactionsById(transactions, latestLoaded).filter((item) => item.medId === medId);
      const plan = planLotRecount(completeTransactions, medId, adjustLotRows);
      const latestGlobalStock = computeMedStock(completeTransactions, medId);
      if (!plan.valid) {
        alert('La distribucion dejo de ser valida. Revise las filas del recuento.');
        return;
      }
      if (plan.currentLotStock !== adjustLotContext.lotStock || latestGlobalStock !== adjustLotContext.globalStock) {
        alert(
          `El medicamento cambio mientras se contaba (saldo ${adjustLotContext.globalStock} -> ${latestGlobalStock}, lotes ${adjustLotContext.lotStock} -> ${plan.currentLotStock}). ` +
            'Se recargaron las existencias: revise el recuento y vuelva a aplicarlo.',
        );
        await loadAdjustLotContext(medId);
        return;
      }
      const createdAt = Date.now();
      const now = new Date().toLocaleString('es-CR', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true,
        timeZone: CR_TIMEZONE,
      });
      const groupId = `lot-adjust-${medId}-${createdAt}`;
      const baseFields = {
        date: now,
        medId,
        cama: '',
        prescription: '',
        dosis: '',
        rxType: 'CERRADA',
        rxQuantity: 0,
        rxUsed: 0,
        pharmacist,
        service: 'AJUSTE MANUAL DE LOTES',
        isLotAdjustment: true,
        affectsGlobalStock: false,
        adjustmentGroupId: groupId,
      };
      const releaseTransaction =
        plan.currentLotStock > 0
          ? {
              ...baseFields,
              id: `${createdAt}-release`,
              createdAt,
              type: 'OUT',
              amount: plan.currentLotStock,
              observacion: 'LIBERACION DE EXISTENCIAS POR RECUENTO; NO AFECTA EL SALDO GLOBAL',
              lotAllocations: plan.releaseAllocations,
            }
          : null;
      const lotTransactions = plan.rows.map((row, index) => ({
        ...baseFields,
        id: `${createdAt}-lot-${index}`,
        createdAt: createdAt + index + 1,
        type: 'IN',
        amount: row.quantity,
        observacion: 'EXISTENCIA DECLARADA EN RECUENTO; NO AFECTA EL SALDO GLOBAL',
        lotNumber: row.lotNumber,
        expirationDate: row.expirationDate,
      }));
      const anchorTransaction = {
        id: createdAt + plan.rows.length + 2,
        date: now,
        createdAt: createdAt + plan.rows.length + 2,
        medId,
        type: 'IN',
        amount: 0,
        service: 'AJUSTE MANUAL DE SALDO',
        cama: '',
        prescription: '',
        rxType: 'CERRADA',
        rxQuantity: 0,
        rxUsed: 0,
        pharmacist,
        observacion: `RECUENTO DE LOTES: ${plan.newTotal} UNIDAD(ES) EN ${plan.rows.length} LOTE(S)`,
        isCierre: true,
        cierreTurno: 'AJUSTE MANUAL SALDO',
        totalRecetas: 0,
        totalMedicamento: plan.newTotal,
        adjustmentGroupId: groupId,
      };
      const written = [...(releaseTransaction ? [releaseTransaction] : []), ...lotTransactions, anchorTransaction];
      const batch = writeBatch(db);
      written.forEach((item) => batch.set(doc(db, dataDocPath, 'transactions', String(item.id)), item));
      await batch.commit();
      setTransactions((prev) => mergeTransactionsById(prev, written));
      invalidateLotIntegrity(medId);
      logSyncEvent('lot_recount', `medId=${medId} total=${plan.newTotal} lots=${plan.rows.length}`);
      setCloudStatus('Sincronizado');
      alert(`Recuento aplicado. Saldo y existencia por lotes quedaron en ${plan.newTotal}.`);
      await loadAdjustLotContext(medId);
    } catch (error) {
      console.error(error);
      setCloudStatus('Sin conexion');
      alert('No se pudo aplicar el recuento. No se modifico nada.');
    } finally {
      setAdjustLotSaving(false);
    }
  };

  // La correccion de lote reescribe el ingreso de origen y los egresos ya
  // asignados a el. Si alguno quedo dentro de un periodo cerrado, la correccion
  // estaria modificando historial inmutable, asi que se bloquea.
  const findClosureLockedInPlan = (items, plan) => {
    const ids = new Set([
      String(plan?.origin?.sourceTransactionId),
      ...(plan?.affectedTransactions || []).map((item) => String(item.id)),
    ]);
    return (items || []).filter((t) => ids.has(String(t.id)) && isLockedTransaction(t));
  };

  const blockIfClosureLockedPlan = (items, plan) => {
    const locked = findClosureLockedInPlan(items, plan);
    if (locked.length === 0) return false;
    alert(
      'No se puede corregir este lote.\n\n' +
      `${locked.length} de los movimientos afectados son anteriores a un CIERRE 24 HORAS y el periodo ya esta cerrado.\n` +
      'Registre un ajuste de saldo en el periodo abierto en lugar de reescribir el historial.',
    );
    return true;
  };

  // Correccion de digitacion: reescribe el origen y el snapshot que quedo en los
  // egresos ya asignados. No mueve cantidades, por lo que no lleva ancla.
  const applyLotCorrection = async () => {
    const medId = adjustLotContext?.medId;
    if (!medId || adjustLotSaving) return;
    if (!lotInitializationByMedId[medId]?.completed) return;
    if (pendingCount > 0) {
      alert('Sincronice los movimientos pendientes antes de ajustar lotes.');
      return;
    }
    const draftPlan = planLotCorrection(
      transactions.filter((item) => item.medId === medId),
      medId,
      adjustCorrectionSourceId,
      { lotNumber: adjustCorrectionLotNumber, expirationDate: adjustCorrectionExpirationDate },
    );
    if (!draftPlan.valid) {
      const [error] = draftPlan.errors;
      alert(
        error === 'NO_CHANGES'
          ? 'No hay cambios que aplicar: el lote y la fecha son los mismos.'
          : error === 'MISSING_LOT_NUMBER'
            ? 'Ingrese el numero de lote corregido.'
            : error === 'INVALID_EXPIRATION_DATE'
              ? 'Ingrese una fecha de expiracion valida.'
              : 'No se encontro el lote seleccionado. Recargue las existencias.',
      );
      return;
    }
    if (blockIfClosureLockedPlan(transactions, draftPlan)) return;
    const confirmed = await requestStyledConfirm(
      `Confirme la correccion del lote ${draftPlan.origin.lotNumber} (${formatLotExpirationDate(draftPlan.origin.expirationDate)}) a ` +
        `${draftPlan.lotNumber} (${formatLotExpirationDate(draftPlan.expirationDate)}). ` +
        `Se actualizaran tambien ${draftPlan.affectedTransactions.length} egreso(s) ya asignados a ese lote.`,
    );
    if (!confirmed) return;
    const authorized = await requestSecurityKey();
    if (!authorized) return;
    setAdjustLotSaving(true);
    setCloudStatus('Corrigiendo lote...');
    try {
      const latestLoaded = await loadAllForMed(medId);
      if (!Array.isArray(latestLoaded)) throw new Error('No se pudo reverificar el lote.');
      const completeTransactions = mergeTransactionsById(transactions, latestLoaded).filter((item) => item.medId === medId);
      const plan = planLotCorrection(completeTransactions, medId, adjustCorrectionSourceId, {
        lotNumber: adjustCorrectionLotNumber,
        expirationDate: adjustCorrectionExpirationDate,
      });
      if (!plan.valid) {
        alert('El lote cambio mientras se editaba. Recargue las existencias e intente de nuevo.');
        await loadAdjustLotContext(medId);
        return;
      }
      // Reverificacion sobre el historial completo: la lista en memoria pudo no
      // incluir egresos viejos ya congelados.
      if (blockIfClosureLockedPlan(completeTransactions, plan)) return;
      const batch = writeBatch(db);
      batch.set(
        doc(db, dataDocPath, 'transactions', String(plan.origin.sourceTransactionId)),
        { lotNumber: plan.lotNumber, expirationDate: plan.expirationDate },
        { merge: true },
      );
      plan.affectedTransactions.forEach((item) => {
        batch.set(doc(db, dataDocPath, 'transactions', String(item.id)), { lotAllocations: item.lotAllocations }, { merge: true });
      });
      await batch.commit();
      setTransactions((prev) =>
        prev.map((item) => {
          if (String(item.id) === String(plan.origin.sourceTransactionId)) {
            return { ...item, lotNumber: plan.lotNumber, expirationDate: plan.expirationDate };
          }
          const patch = plan.affectedTransactions.find((entry) => String(entry.id) === String(item.id));
          return patch ? { ...item, lotAllocations: patch.lotAllocations } : item;
        }),
      );
      invalidateLotIntegrity(medId);
      logSyncEvent('lot_correction', `medId=${medId} lot=${plan.lotNumber} touched=${plan.affectedTransactions.length}`);
      setCloudStatus('Sincronizado');
      alert(`Lote corregido. Se actualizaron ${plan.affectedTransactions.length} egreso(s) relacionados.`);
      await loadAdjustLotContext(medId);
    } catch (error) {
      console.error(error);
      setCloudStatus('Sin conexion');
      alert('No se pudo corregir el lote. No se modifico nada.');
    } finally {
      setAdjustLotSaving(false);
    }
  };

  const openLotInitialization = async (medId) => {
    if (!medId || lotInitializationByMedId[medId]?.completed) return;
    if (pendingCount > 0) {
      alert('Sincronice los movimientos pendientes antes de inicializar lotes.');
      return;
    }
    setCloudStatus('Verificando saldo completo...');
    const loaded = await loadAllForMed(medId);
    if (!Array.isArray(loaded)) {
      setCloudStatus('Sin conexion');
      alert('No se pudo cargar el historial completo del medicamento. Intente de nuevo.');
      return;
    }
    const completeTransactions = mergeTransactionsById(transactions, loaded);
    const targetStock = computeMedStock(completeTransactions, medId);
    if (targetStock < 0) {
      alert('El medicamento tiene saldo negativo. Debe corregirlo antes de inicializar lotes.');
      return;
    }
    setLotInitializationMedId(medId);
    setLotInitializationTargetStock(targetStock);
    setLotInitializationRows(targetStock > 0 ? [{ lotNumber: '', expirationDate: '', quantity: '' }] : []);
    setLotInitializationPharmacist(pharmacists[0] || '');
    setModalType('lot-initialization');
    setShowModal(true);
    setCloudStatus('Sincronizado');
  };

  const updateLotInitializationRow = (index, field, value) => {
    setLotInitializationRows((prev) => prev.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)));
  };

  const adjustRecountTotal = useMemo(
    () => adjustLotRows.reduce((sum, row) => sum + (Number.parseInt(row.quantity, 10) || 0), 0),
    [adjustLotRows],
  );

  const lotInitializationValidation = useMemo(
    () => validateLotInitialization(lotInitializationRows, lotInitializationTargetStock),
    [lotInitializationRows, lotInitializationTargetStock],
  );

  // Guardia para el cierre: el total a grabar (totalMedicamento) se calcula sobre
  // los movimientos cargados. Si el historial del medicamento no esta completo,
  // ese total podria salir sobre datos parciales y corromper el ancla de saldo.
  const ensureMedFullyLoadedForCierre = async () => {
    const status = medLoadStatus[selectedMedId];
    if (status === 'loading') {
      alert('Cargando el historial completo del medicamento. Espere unos segundos e intente de nuevo.');
      return false;
    }
    if (status === 'complete') return true;
    // 'idle'/'error' (p. ej. indice Firestore aun no creado): no podemos garantizar
    // que el historial este completo. Avisar y exigir confirmacion explicita.
    return requestStyledConfirm(
      'No se pudo verificar el historial COMPLETO de este medicamento (posible indice de Firestore faltante). ' +
        'El total del cierre podria calcularse sobre datos parciales y descuadrar el saldo. ¿Desea continuar de todos modos?',
    );
  };

  const handleSave = async (e) => {
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

    if (modalType === 'lot-initialization') {
      if (lotInitializationByMedId[lotInitializationMedId]?.completed || lotInitializationSaving) return;
      const pharmacist = toUpper(formData.get('lotInitializationPharmacist'));
      const validation = validateLotInitialization(lotInitializationRows, lotInitializationTargetStock);
      if (!pharmacist) {
        alert('Seleccione el farmaceutico responsable.');
        return;
      }
      if (!validation.valid) {
        alert('La distribucion no es valida. Revise lotes, fechas, cantidades y la diferencia pendiente.');
        return;
      }
      const expiredRows = validation.rows.filter((row) => isLotExpired(row.expirationDate));
      if (expiredRows.length > 0) {
        const proceedExpired = await requestStyledConfirm(
          `La distribucion incluye ${expiredRows.length} lote(s) vencido(s). Se registraran para trazabilidad, pero no se usaran automaticamente. ¿Desea continuar?`,
        );
        if (!proceedExpired) return;
      }
      const confirmed = await requestStyledConfirm(
        `Confirme la inicializacion unica de ${medications.find((med) => med.id === lotInitializationMedId)?.name || lotInitializationMedId} con ${validation.total} unidades en ${validation.rows.length} lote(s).`,
      );
      if (!confirmed) return;
      setLotInitializationSaving(true);
      try {
        const latestLoaded = await loadAllForMed(lotInitializationMedId);
        if (!Array.isArray(latestLoaded)) throw new Error('No se pudo verificar el saldo final.');
        const completeTransactions = mergeTransactionsById(transactions, latestLoaded);
        const latestStock = computeMedStock(completeTransactions, lotInitializationMedId);
        if (latestStock !== lotInitializationTargetStock) {
          alert(`El saldo cambio de ${lotInitializationTargetStock} a ${latestStock}. Vuelva a abrir el asistente para conciliarlo.`);
          return;
        }
        const groupId = `lot-init-${lotInitializationMedId}-${Date.now()}`;
        const createdAt = Date.now();
        const initializationTransactions = validation.rows.map((row, index) => ({
          id: `${createdAt}-${index}`,
          date: now,
          createdAt: createdAt + index,
          medId: lotInitializationMedId,
          type: 'IN',
          amount: row.quantity,
          service: 'INICIALIZACION DE LOTES',
          cama: '',
          prescription: '',
          dosis: '',
          rxType: 'CERRADA',
          rxQuantity: 0,
          rxUsed: 0,
          observacion: 'DISTRIBUCION INICIAL DE EXISTENCIAS; NO AFECTA EL SALDO GLOBAL',
          pharmacist,
          lotNumber: row.lotNumber,
          expirationDate: row.expirationDate,
          isLotInitialization: true,
          affectsGlobalStock: false,
          initializationGroupId: groupId,
        }));
        const completedState = {
          completed: true,
          completedAt: new Date().toISOString(),
          completedBy: pharmacist,
          targetStock: validation.target,
          distributedQuantity: validation.total,
          lotCount: validation.rows.length,
          groupId,
        };
        const nextInitializationState = { ...lotInitializationByMedId, [lotInitializationMedId]: completedState };
        const batch = writeBatch(db);
        initializationTransactions.forEach((item) => {
          batch.set(doc(db, dataDocPath, 'transactions', String(item.id)), item);
        });
        batch.set(doc(db, dataDocPath), { lotInitializationByMedId: nextInitializationState }, { merge: true });
        await batch.commit();
        setTransactions((prev) => [...initializationTransactions, ...prev]);
        setLotInitializationByMedId(nextInitializationState);
      } catch (error) {
        console.error(error);
        alert('No se pudo completar la inicializacion. No se marco el medicamento como inicializado.');
        return;
      } finally {
        setLotInitializationSaving(false);
      }
    } else if (modalType === 'kardex') {
      const rxType = isQuickIngreso ? 'CERRADA' : formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const amount = parseInt(formData.get('amount'), 10) || 0;
      const medId = formData.get('medicationId');
      const prescription = isQuickIngreso ? '' : toUpper(formData.get('prescription'));
      const lotNumber = isQuickIngreso ? toUpper(formData.get('lotNumber')) : '';
      const expirationDate = isQuickIngreso ? String(formData.get('expirationDate') || '') : '';
      if (isQuickIngreso) {
        const validation = validateLotEntry({ amount, lotNumber, expirationDate });
        if (validation.errors.includes('INVALID_AMOUNT')) {
          alert('La cantidad del ingreso debe ser un entero mayor que cero.');
          return;
        }
        if (validation.errors.includes('MISSING_LOT_NUMBER')) {
          alert('Ingrese el numero de lote.');
          return;
        }
        if (validation.errors.includes('INVALID_EXPIRATION_DATE')) {
          alert('Ingrese una fecha de expiracion valida.');
          return;
        }
        if (isLotExpired(expirationDate)) {
          const proceed = await requestStyledConfirm(
            `El lote ${lotNumber} ya esta vencido (${expirationDate}). ¿Desea registrar el ingreso de todos modos?`,
          );
          if (!proceed) return;
        }
      }
      const rxUsed =
        rxType === 'ABIERTA' && rxQuantity > 0 ? nextOpenRxUse(transactions, medId, prescription, rxQuantity, amount) : 0;
      if (!isQuickIngreso) {
        const proceed = await confirmIfNegativeStock(medId, amount);
        if (!proceed) return;
      }
      const lotAllocations = isQuickIngreso ? null : await prepareLotAllocations(medId, amount);
      if (!isQuickIngreso && !lotAllocations) return;
      const newTransaction = {
        id: Date.now(),
        date: now,
        createdAt: Date.now(),
        medId,
        type: isQuickIngreso ? 'IN' : 'OUT',
        amount,
        service: isQuickIngreso ? 'INGRESO A INVENTARIO' : toUpper(formData.get('service')),
        cama: isQuickIngreso ? '' : toUpper(formData.get('cama')),
        prescription,
        dosis: toUpper(formData.get('dosis')),
        rxType,
        rxQuantity,
        rxUsed,
        observacion: isQuickIngreso ? '' : toUpper(formData.get('observacion')),
        pharmacist: toUpper(formData.get('pharmacist') || pharmacists[0] || ''),
        ...(isQuickIngreso ? { lotNumber, expirationDate } : {}),
        ...(!isQuickIngreso ? { lotAllocations } : {}),
      };
      const okKardex = enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
      if (!okKardex) {
        notifyWriteFailed(isQuickIngreso ? 'el ingreso' : 'el rebajo');
        return;
      }
      setTransactions([newTransaction, ...transactions]);
    } else if (modalType === 'kardex-edit') {
      const current = transactions.find((t) => t.id === editingTransactionId);
      if (!current) {
        alert('No se encontro el movimiento que desea editar.');
        return;
      }
      // Corte temprano: el movimiento pertenece a un periodo ya cerrado.
      if (isLockedTransaction(current)) {
        notifyClosureLocked('modificar este movimiento');
        setShowModal(false);
        return;
      }
      const isIncome = current.type === 'IN';
      const rxType = isIncome ? 'CERRADA' : formData.get('rxType');
      const rxQuantity = rxType === 'ABIERTA' ? parseInt(formData.get('rxQuantity'), 10) || 0 : 0;
      const amount = parseInt(formData.get('amount'), 10) || 0;
      const medId = formData.get('medicationId');
      const prescription = isIncome ? '' : toUpper(formData.get('prescription'));
      const lotNumber = isIncome ? toUpper(formData.get('lotNumber')) : '';
      const expirationDate = isIncome ? String(formData.get('expirationDate') || '') : '';
      if (isIncome) {
        const validation = validateLotEntry({ amount, lotNumber, expirationDate });
        if (validation.errors.includes('INVALID_AMOUNT')) {
          alert('La cantidad del ingreso debe ser un entero mayor que cero.');
          return;
        }
        if (validation.errors.includes('MISSING_LOT_NUMBER') || validation.errors.includes('INVALID_EXPIRATION_DATE')) {
          alert('Ingrese un numero de lote y una fecha de expiracion validos.');
          return;
        }
        const editState = getLotOriginEditState(transactions, current, { medId, amount, lotNumber, expirationDate });
        if (!editState.allowed) {
          const usedQuantity = editState.usedQuantity;
          alert(`Este ingreso ya tiene ${usedQuantity} unidades asignadas a egresos. No se puede cambiar medicamento, cantidad, lote ni expiracion.`);
          return;
        }
        if (isLotExpired(expirationDate) && expirationDate !== current.expirationDate) {
          const proceed = await requestStyledConfirm(
            `El lote ${lotNumber} ya esta vencido (${expirationDate}). ¿Desea guardar el cambio de todos modos?`,
          );
          if (!proceed) return;
        }
      }
      const lotAllocations = isIncome ? null : await prepareLotAllocations(medId, amount, editingTransactionId);
      if (!isIncome && !lotAllocations) return;
      const rxUsed =
        rxType !== 'ABIERTA'
          ? 0
          : current?.rxType === 'ABIERTA'
            ? Math.min(Math.max(Number(current?.rxUsed) || 0, amount), rxQuantity)
            : Math.max(
                amount || 1,
                Math.min(
                  nextOpenRxUse(
                    transactions.filter((t) => t.id !== editingTransactionId),
                    medId,
                    prescription,
                    rxQuantity,
                    amount,
                  ),
                  rxQuantity || 1,
                ),
              );
      const updated = {
        ...current,
        id: editingTransactionId,
        // Conservar la fecha original: editar el contenido de un movimiento no
        // debe moverlo a otro periodo ni cambiar la fecha mostrada en el Kardex.
        date: current?.date || now,
        createdAt: current?.createdAt ?? parseDateTime(current?.date || now)?.getTime() ?? Date.now(),
        medId,
        type: isIncome ? 'IN' : 'OUT',
        amount,
        service: isIncome ? 'INGRESO A INVENTARIO' : toUpper(formData.get('service')),
        cama: isIncome ? '' : toUpper(formData.get('cama')),
        prescription,
        dosis: isIncome ? '' : toUpper(formData.get('dosis')),
        rxType,
        rxQuantity,
        rxUsed,
        observacion: isIncome ? '' : toUpper(formData.get('observacion')),
        pharmacist: toUpper(formData.get('pharmacist')),
        ...(isIncome ? { lotNumber, expirationDate } : {}),
        ...(!isIncome ? { lotAllocations } : {}),
      };
      const okKardexEdit = enqueueWrite({ type: 'set', collection: 'transactions', id: updated.id, data: updated });
      if (!okKardexEdit) {
        notifyWriteFailed('la edicion');
        return;
      }
      setTransactions(transactions.map((t) => (t.id === editingTransactionId ? updated : t)));
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
      const okExp = enqueueWrite({ type: 'set', collection: 'expedientes', id: newExp.id, data: newExp });
      if (!okExp) {
        notifyWriteFailed('el expediente');
        return;
      }
      setExpedientes([newExp, ...expedientes]);
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
      const okExpEdit = enqueueWrite({ type: 'set', collection: 'expedientes', id: updated.id, data: updated });
      if (!okExpEdit) {
        notifyWriteFailed('la edicion del expediente');
        return;
      }
      setExpedientes(expedientes.map((e) => (e.id === editingExpedienteId ? updated : e)));
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
        const okRateChg = enqueueWrite({ type: 'set', collection: 'expedientes', id: newEntry.id, data: newEntry });
        if (!okRateChg) {
          notifyWriteFailed('el cambio de velocidad');
          return;
        }
        setExpedientes([newEntry, ...expedientes]);
      }
    } else if (modalType === 'cierre') {
      if (pendingCount > 0) {
        alert('No puede guardar cierre con pendientes de sincronizacion.');
        return;
      }
      if (medLoadStatus[selectedMedId] === 'loading') {
        alert('Cargando el historial completo del medicamento. Espere a que termine antes de cerrar.');
        return;
      }
      let verifiedClosingStock = Number(selectedCurrentStock) || 0;
      if (lotInitializationByMedId[selectedMedId]?.completed) {
        const integrity = await verifyLotIntegrity(selectedMedId, { notify: false });
        if (!integrity?.match) {
          alert('No puede guardar el cierre: el saldo global no coincide con las existencias por lote. Revise la integridad en Configuracion.');
          return;
        }
        verifiedClosingStock = integrity.globalStock;
      }
      const cierreTurno = toUpper(formData.get('turno'));
      const computedTotalMedicamento = verifiedClosingStock;
      if (cierreTurno === CLOSURE_24H_TURNO) {
        const lockedCount = transactions.filter((t) => t.medId === selectedMedId).length;
        const medName = medications.find((m) => m.id === selectedMedId)?.name || selectedMedId;
        const confirmClosure = await requestStyledConfirm(
          `Este CIERRE 24 HORAS congelara el historial de ${medName}: ` +
            `${lockedCount} movimiento(s) anteriores quedaran inmutables (no se podran editar ni eliminar), ` +
            'incluido el cierre mismo. ¿Desea continuar?',
        );
        if (!confirmClosure) return;
      }
      // El corte se fija despues de confirmar, para que un movimiento registrado
      // mientras el dialogo estaba abierto no quede del lado equivocado del cierre.
      const closureCreatedAt = Date.now();
      const newCierre = {
        id: closureCreatedAt,
        date: now,
        createdAt: closureCreatedAt,
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
      const okCierre = enqueueWrite({ type: 'set', collection: 'transactions', id: newCierre.id, data: newCierre });
      if (!okCierre) {
        notifyWriteFailed('el cierre');
        return;
      }
      setTransactions([newCierre, ...transactions]);
      if (cierreTurno === CLOSURE_24H_TURNO) {
        // El candado persistido es lo que leen las reglas de Firestore: sin el,
        // el bloqueo solo existiria en pantalla. Va por la misma cola que el
        // cierre, asi que respeta el modo sin conexion.
        const okLock = enqueueWrite({
          type: 'set',
          collection: 'closureLocks',
          id: selectedMedId,
          data: {
            id: selectedMedId,
            medId: selectedMedId,
            cutoff: closureCreatedAt,
            closureId: newCierre.id,
            updatedAt: closureCreatedAt,
            updatedBy: newCierre.pharmacist,
            reset: false,
          },
        });
        if (!okLock) notifyWriteFailed('el bloqueo del cierre de 24 horas');
        else setClosureLocksByMedId((prev) => ({ ...prev, [selectedMedId]: closureCreatedAt }));
      }
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
      if (updatedTx) {
        const okCross = enqueueWrite({ type: 'set', collection: 'transactions', id: updatedTx.id, data: updatedTx });
        if (!okCross) {
          notifyWriteFailed('la verificacion cruzada');
          return;
        }
      }
      setTransactions(updatedTransactions);
    } else if (modalType === 'open-rx-use') {
      if (!pendingOpenRxTransaction) return;
      const selectedPharmacist = toUpper(formData.get('openRxPharmacist'));
      const selectedAmount = parseInt(formData.get('openRxAmount'), 10);
      if (!selectedPharmacist) return;
      if (!Number.isFinite(selectedAmount) || selectedAmount <= 0) return;
      await handleOpenRxUse(pendingOpenRxTransaction, selectedPharmacist, selectedAmount);
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
      const okOpenRxAdj = enqueueWrite({ type: 'set', collection: 'transactions', id: updated.id, data: updated });
      if (!okOpenRxAdj) {
        notifyWriteFailed('el ajuste de receta abierta');
        return;
      }
      setTransactions(transactions.map((t) => (t.id === updated.id ? updated : t)));
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
      const okRepeat = enqueueWrite({ type: 'set', collection: 'expedientes', id: duplicated.id, data: duplicated });
      if (!okRepeat) {
        notifyWriteFailed('la repeticion del expediente');
        return;
      }
      setExpedientes([duplicated, ...expedientes]);
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
      const okBitacora = enqueueWrite({ type: 'set', collection: 'bitacora', id: newEntry.id, data: newEntry });
      if (!okBitacora) {
        notifyWriteFailed('la entrada de bitacora');
        return;
      }
      setBitacora([newEntry, ...bitacora]);
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
      const okSvc = enqueueWrite({
        type: 'set',
        collection: 'catalog_services',
        id: toCatalogId(newService),
        data: { id: toCatalogId(newService), name: newService, createdAt: Date.now() },
      });
      if (!okSvc) {
        notifyWriteFailed('el servicio');
        return;
      }
      setServices(nextServices);
    } else if (modalType === 'pharmacist-add') {
      const newPharmacist = toUpper(formData.get('pharmacistName'));
      const nextPharmacists = [newPharmacist, ...pharmacists.filter((p) => p !== newPharmacist)];
      const okPharm = enqueueWrite({
        type: 'set',
        collection: 'catalog_pharmacists',
        id: toCatalogId(newPharmacist),
        data: { id: toCatalogId(newPharmacist), name: newPharmacist, createdAt: Date.now() },
      });
      if (!okPharm) {
        notifyWriteFailed('el farmaceutico');
        return;
      }
      setPharmacists(nextPharmacists);
    } else if (modalType === 'condition-add') {
      const newCondition = toUpper(formData.get('conditionName'));
      const nextCondiciones = [newCondition, ...condiciones.filter((c) => c !== newCondition)];
      const okCond = enqueueWrite({
        type: 'set',
        collection: 'catalog_condiciones',
        id: toCatalogId(newCondition),
        data: { id: toCatalogId(newCondition), name: newCondition, createdAt: Date.now() },
      });
      if (!okCond) {
        notifyWriteFailed('la condicion');
        return;
      }
      setCondiciones(nextCondiciones);
    } else if (modalType === 'reintegro') {
      const rxQuantity = 0;
      const rxType = 'CERRADA';
      const amount = parseInt(formData.get('amount'), 10) || 0;
      const medId = formData.get('medicationId');
      const receta = toUpper(formData.get('receta'));
      const motivo = toUpper(formData.get('motivo'));
      const lotNumber = toUpper(formData.get('lotNumber'));
      const expirationDate = String(formData.get('expirationDate') || '');
      const lotValidation = validateLotEntry({ amount, lotNumber, expirationDate });
      if (!lotValidation.valid) {
        alert('Ingrese una cantidad, un numero de lote y una fecha de expiracion validos para el reintegro.');
        return;
      }
      if (isLotExpired(expirationDate)) {
        const proceedExpired = await requestStyledConfirm(
          `El lote ${lotNumber} esta vencido (${expirationDate}). ¿Desea registrar el reintegro de todos modos?`,
        );
        if (!proceedExpired) return;
      }
      const prescription = `RECETA ${receta} - ${motivo}`;
      const newTransaction = {
        id: Date.now(),
        date: now,
        createdAt: Date.now(),
        medId,
        type: 'IN',
        amount,
        service: 'REINTEGRO',
        cama: '',
        prescription, // Storing combined Receta + Motivo
        rxType,
        rxQuantity,
        rxUsed: 0,
        pharmacist: toUpper(formData.get('farmaceutico') || pharmacists[0] || ''),
        lotNumber,
        expirationDate,
      };
      const okReint = enqueueWrite({ type: 'set', collection: 'transactions', id: newTransaction.id, data: newTransaction });
      if (!okReint) {
        notifyWriteFailed('el reintegro');
        return;
      }
      setTransactions([newTransaction, ...transactions]);
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
      return isClosure24h(t) ? '!bg-rose-50 hover:!bg-rose-50' : '!bg-amber-50 hover:!bg-amber-50';
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

  const editingTransaction = transactions.find((t) => t.id === editingTransactionId);
  const editingLotUsedQuantity =
    editingTransaction?.type === 'IN'
      ? getLotUsage(transactions, editingTransaction.medId)[String(editingTransaction.id)] || 0
      : 0;


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
      {writeBlockedByStorage && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-rose-600 text-white px-4 py-3 shadow-lg border-b-2 border-rose-800">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div className="flex-1">
              <p className="text-sm font-bold uppercase tracking-wider">
                ESCRITURAS BLOQUEADAS - Almacenamiento local sin espacio
              </p>
              <p className="text-xs mt-0.5 opacity-90">
                Los nuevos rebajos/ingresos NO se estan guardando. Sincronice pendientes o libere espacio antes de continuar.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (typeof flushWriteQueue === 'function') flushWriteQueue();
                }}
                className="bg-white text-rose-700 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider hover:bg-rose-50"
              >
                Reintentar Sincronizacion
              </button>
              <button
                type="button"
                onClick={() => {
                  try { localStorage.removeItem('pharmaControlData'); } catch { /* noop */ }
                  setWriteBlockedByStorage(false);
                  setSyncError('');
                  logSyncEvent('manual_unblock', 'Cache local purgado por usuario.');
                }}
                className="bg-rose-900 text-white px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider hover:bg-rose-950"
              >
                Liberar Cache Local
              </button>
            </div>
          </div>
        </div>
      )}
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
                    onClick={async () => {
                      if (pendingCount > 0) {
                        alert('No puede realizar cierre con pendientes de sincronizacion.');
                        return;
                      }
                      const fullyLoaded = await ensureMedFullyLoadedForCierre();
                      if (!fullyLoaded) return;
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
                      // Eliminar el medicamento borra sus movimientos en cascada. Si alguno
                      // quedo congelado por un CIERRE 24 HORAS, esa via destruiria historial
                      // cerrado por la puerta de atras: se bloquea igual que el borrado directo.
                      const lockedCount = countLockedTransactions(transactions, selectedMedId, closureCutoffByMedId);
                      if (lockedCount > 0) {
                        alert(
                          `No se puede eliminar ${med?.name || 'este medicamento'}.\n\n` +
                          `Tiene ${lockedCount} movimiento(s) congelados por un CIERRE 24 HORAS y el historial cerrado es inmutable.`,
                        );
                        return;
                      }
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
                  {medLoadStatus[selectedMedId] === 'loading' && (
                    <p className="text-[8px] font-bold uppercase tracking-wider text-amber-600">Cargando historial...</p>
                  )}
                  {medLoadStatus[selectedMedId] === 'complete' && (
                    <p className="text-[8px] font-bold uppercase tracking-wider text-emerald-600">Historial completo</p>
                  )}
                  {medLoadStatus[selectedMedId] === 'error' && (
                    <button
                      type="button"
                      onClick={() => loadAllForMed(selectedMedId)}
                      className="text-[8px] font-bold uppercase tracking-wider text-rose-600 underline hover:text-rose-700"
                      title="No se pudo cargar el historial completo. Click para reintentar."
                    >
                      Historial parcial - Reintentar
                    </button>
                  )}
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
                            {isClosure24h(t) ? 'CIERRE' : 'INVENTARIO'}
                          </span>
                        ) : (
                          <div className="flex flex-col items-center gap-1">
                            <span
                              className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}
                              title={t.type === 'OUT' ? formatLotTooltip(t) : undefined}
                              aria-label={t.type === 'OUT' ? `${t.amount} unidades. ${formatLotTooltip(t)}` : undefined}
                            >
                              {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                              {t.amount}
                            </span>
                            {t.type === 'IN' && t.lotNumber && (
                              <span className="text-[9px] font-bold text-slate-500 uppercase">
                                Lote {t.lotNumber} · Exp. {formatLotExpirationDate(t.expirationDate)}
                              </span>
                            )}
                            {t.type === 'OUT' && Array.isArray(t.lotAllocations) && t.lotAllocations.length > 0 && (
                              <span className="cursor-help text-[9px] font-bold uppercase text-blue-600" title={formatLotTooltip(t)}>
                                {t.lotAllocations.length} lote(s) · ver detalle
                              </span>
                            )}
                          </div>
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
                          isClosure24h(t) ? (
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
                              {rxProgressById[t.id] ?? getRxProgress(t)}
                            </span>
                          </button>
                        ) : (
                          <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                        <div className="flex flex-col items-center">
                          <span className="inline-flex items-center gap-1">
                            {t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}
                            {!t.isCierre && t.observacion && (
                              <button
                                type="button"
                                onClick={() => setObservationView(t)}
                                title={t.observacion}
                                aria-label="Ver observacion"
                                className="text-amber-500 hover:text-amber-600"
                              >
                                <FileText size={13} />
                              </button>
                            )}
                          </span>
                          {!t.isCierre && t.dosis && (
                            <span className="text-[10px] text-slate-400 font-bold uppercase mt-1">{t.dosis}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2 justify-center items-center min-w-[150px] mx-auto">
                          {!t.isCierre && !isLockedTransaction(t) && (
                            <button
                              onClick={() => {
                                setEditingTransactionId(t.id);
                                setModalType('kardex-edit');
                                setRxTypeValue(t.rxType || 'CERRADA');
                                setIsQuickIngreso(t.type === 'IN');
                                setShowModal(true);
                              }}
                              className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                            >
                              Editar
                            </button>
                          )}
                          {t.isCierre && !isLockedTransaction(t) && (
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
                          {isLockedTransaction(t) ? (
                            <span
                              className="flex items-center gap-1 bg-slate-100 border border-slate-300 text-slate-500 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider"
                              title={CLOSURE_LOCK_HINT}
                            >
                              <Lock size={12} /> Cerrado
                            </span>
                          ) : (
                            <button
                              onClick={() => {
                                requestStyledConfirm(`Eliminar movimiento: ${getTransactionLabel(t)}?`).then((confirmDelete) => {
                                  if (!confirmDelete) return;
                                  const okDel = enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                                  if (!okDel) {
                                    notifyWriteFailed('la eliminacion');
                                    return;
                                  }
                                  setTransactions(transactions.filter((tx) => tx.id !== t.id));
                                });
                              }}
                              className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                            >
                              Eliminar
                            </button>
                          )}
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
                              {isClosure24h(t) ? 'CIERRE' : 'INVENTARIO'}
                            </span>
                          ) : (
                            <div className="flex flex-col items-center gap-1">
                              <span
                                className={`font-bold inline-flex items-center gap-1 ${t.type === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}
                                title={t.type === 'OUT' ? formatLotTooltip(t) : undefined}
                                aria-label={t.type === 'OUT' ? `${t.amount} unidades. ${formatLotTooltip(t)}` : undefined}
                              >
                                {t.type === 'IN' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                                {t.amount}
                              </span>
                              {t.type === 'IN' && t.lotNumber && (
                                <span className="text-[9px] font-bold text-slate-500 uppercase">
                                  Lote {t.lotNumber} · Exp. {formatLotExpirationDate(t.expirationDate)}
                                </span>
                              )}
                              {t.type === 'OUT' && Array.isArray(t.lotAllocations) && t.lotAllocations.length > 0 && (
                                <span className="cursor-help text-[9px] font-bold uppercase text-blue-600" title={formatLotTooltip(t)}>
                                  {t.lotAllocations.length} lote(s) · ver detalle
                                </span>
                              )}
                            </div>
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
                            isClosure24h(t) ? (
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
                                {rxProgressById[t.id] ?? getRxProgress(t)}
                              </span>
                            </button>
                          ) : (
                            <span className="text-xs font-bold uppercase text-slate-500">{t.rxType === 'ABIERTA' ? 'Abierta' : 'Cerrada'}</span>
                          )}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-blue-600 text-center">
                          <span className="inline-flex items-center gap-1">
                            {t.isCierre ? `RECETAS: ${t.totalRecetas}` : t.prescription || '---'}
                            {!t.isCierre && t.observacion && (
                              <button
                                type="button"
                                onClick={() => setObservationView(t)}
                                title={t.observacion}
                                aria-label="Ver observacion"
                                className="text-amber-500 hover:text-amber-600"
                              >
                                <FileText size={13} />
                              </button>
                            )}
                          </span>
                        </td>
                      <td className="px-6 py-4">
                          <div className="flex gap-2 justify-center items-center min-w-[150px] mx-auto">
                            {!t.isCierre && !isLockedTransaction(t) && (
                              <button
                                onClick={() => {
                                  setEditingTransactionId(t.id);
                                  setModalType('kardex-edit');
                                  setRxTypeValue(t.rxType || 'CERRADA');
                                  setIsQuickIngreso(t.type === 'IN');
                                  setShowModal(true);
                                }}
                                className="bg-white border border-slate-200 text-slate-700 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-slate-50"
                              >
                                Editar
                              </button>
                            )}
                            {t.isCierre && !isLockedTransaction(t) && (
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
                            {isLockedTransaction(t) ? (
                              <span
                                className="flex items-center gap-1 bg-slate-100 border border-slate-300 text-slate-500 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider"
                                title={CLOSURE_LOCK_HINT}
                              >
                                <Lock size={12} /> Cerrado
                              </span>
                            ) : (
                              <button
                                onClick={() => {
                                  requestStyledConfirm(`Eliminar movimiento: ${getTransactionLabel(t)}?`).then((confirmDelete) => {
                                    if (!confirmDelete) return;
                                    const okDel = enqueueWrite({ type: 'delete', collection: 'transactions', id: t.id });
                                    if (!okDel) {
                                      notifyWriteFailed('la eliminacion');
                                      return;
                                    }
                                    setTransactions(transactions.filter((tx) => tx.id !== t.id));
                                  });
                                }}
                                className="bg-rose-600 text-white px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider hover:bg-rose-700"
                              >
                                Eliminar
                              </button>
                            )}
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
                            const okDel = enqueueWrite({ type: 'delete', collection: 'expedientes', id: e.id });
                            if (!okDel) {
                              notifyWriteFailed('la eliminacion del expediente');
                              return;
                            }
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
                            className="w-20 border border-slate-200 rounded-md py-1 px-2 text-center text-sm font-bold focus:ring-2 focus:ring-blue-600 outline-none bg-white"
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
                  disabled={backupInProgress || pendingCount > 0}
                  className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {backupInProgress ? 'Generando respaldo...' : 'Descargar Base JSON'}
                </button>
                <button
                  type="button"
                  onClick={() => restoreInputRef.current?.click()}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-blue-700"
                >
                  Cargar y Restaurar JSON
                </button>
                <button
                  type="button"
                  onClick={downloadManualMarkdown}
                  className="bg-violet-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-violet-700"
                >
                  Descargar Manual (Markdown)
                </button>
                <button
                  type="button"
                  onClick={downloadFentanylNotebookMarkdown}
                  className="bg-fuchsia-700 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-fuchsia-800"
                >
                  Informe Fentanilo (NotebookLM)
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
                  <div>
                    <p className="text-[10px] font-bold uppercase text-slate-500">Inicializacion unica de lotes</p>
                    <p className="text-xs text-slate-500 mt-1">Distribuya el saldo actual de cada medicamento antes de activar descargas FEFO.</p>
                  </div>
                  <span className="text-[10px] font-bold text-slate-600">
                    {Object.values(lotInitializationByMedId).filter((item) => item?.completed).length} / {medications.length}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {sortedMedications.map((med) => {
                    const state = lotInitializationByMedId[med.id];
                    const integrity = lotIntegrityAuditByMedId[med.id];
                    return (
                      <div key={med.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-slate-700 truncate">{med.name}</p>
                          <p className="text-[10px] text-slate-500">
                            {state?.completed ? `Saldo conciliado: ${state.targetStock}` : 'El saldo se verificara al abrir'}
                          </p>
                        </div>
                        {state?.completed ? (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-[9px] font-bold uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                              Inicializado · {state.lotCount} lote(s)
                            </span>
                            <button
                              type="button"
                              onClick={() => verifyLotIntegrity(med.id)}
                              disabled={lotIntegrityVerifying || pendingCount > 0}
                              className={`text-[9px] font-bold uppercase rounded border px-2 py-1 disabled:opacity-50 ${
                                integrity?.match
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : integrity
                                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                                    : 'border-blue-200 bg-blue-50 text-blue-700'
                              }`}
                            >
                              {integrity?.match ? `Integridad OK · ${integrity.lotStock}` : integrity ? 'Descuadrado' : 'Verificar integridad'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openLotInitialization(med.id)}
                            disabled={pendingCount > 0}
                            className="text-[9px] font-bold uppercase text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded px-2 py-1"
                          >
                            Inicializar
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={verifyAllLotIntegrity}
                  disabled={lotIntegrityVerifying || pendingCount > 0}
                  className="mt-3 w-full rounded-lg border border-blue-200 bg-blue-50 py-2 text-[10px] font-bold uppercase text-blue-700 disabled:opacity-50"
                >
                  {lotIntegrityVerifying ? 'Verificando...' : 'Verificar integridad de todos los inicializados'}
                </button>
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
                    <div key={check.key} className="rounded-md border border-slate-200 bg-white px-2 py-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold text-slate-700">{check.label}</span>
                        <span className={`text-[10px] font-bold ${check.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {check.ok ? 'OK' : 'FALLA'}
                        </span>
                      </div>
                      {!check.ok &&
                        (check.details || []).map((line) => (
                          <p key={line} className="text-[10px] text-rose-700 mt-1 leading-snug">
                            {line}
                          </p>
                        ))}
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
              <h3 className="font-bold text-slate-800 text-sm">Lotes y Expiraciones Disponibles</h3>
              <p className="text-xs text-slate-500 mt-1">
                Consulta de solo lectura. Muestra el detalle por lote en orden FEFO con el historial completo del medicamento.
              </p>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div className="md:col-span-2">
                  <SelectLabel
                    label="Medicamento"
                    name="lotExplorerMedId"
                    options={sortedMedications.map((m) => ({ value: m.id, label: m.name }))}
                    isObject
                    value={lotExplorerMedId}
                    onChange={(e) => {
                      setLotExplorerMedId(e.target.value);
                      setLotExplorerResult(null);
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => loadLotExplorer(lotExplorerMedId)}
                  disabled={lotExplorerLoading}
                  className="bg-blue-600 text-white px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {lotExplorerLoading ? 'Consultando...' : 'Consultar Lotes'}
                </button>
                <label className="flex items-center gap-2 text-[10px] font-bold uppercase text-slate-600 pb-3">
                  <input
                    type="checkbox"
                    checked={lotExplorerShowDepleted}
                    onChange={(e) => setLotExplorerShowDepleted(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Incluir agotados
                </label>
              </div>
              {lotExplorerResult && lotExplorerResult.medId === lotExplorerMedId && (
                <div className="mt-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { label: 'Saldo global', value: lotExplorerResult.globalStock, tone: 'text-slate-800' },
                      { label: 'Total en lotes', value: lotExplorerResult.totalAvailable, tone: lotExplorerResult.totalAvailable === lotExplorerResult.globalStock ? 'text-emerald-700' : 'text-rose-700' },
                      { label: 'Vigente', value: lotExplorerResult.usableAvailable, tone: 'text-emerald-700' },
                      { label: 'Vencido', value: lotExplorerResult.expiredAvailable, tone: lotExplorerResult.expiredAvailable > 0 ? 'text-rose-700' : 'text-slate-800' },
                    ].map((item) => (
                      <div key={item.label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase text-slate-500">{item.label}</p>
                        <p className={`text-sm font-bold ${item.tone}`}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-slate-500">
                    {lotExplorerResult.medName} · {lotExplorerResult.lotCount} lote(s) con existencia · consultado{' '}
                    {new Date(lotExplorerResult.consultedAt).toLocaleString('es-CR')}
                  </p>
                  {lotExplorerResult.totalAvailable !== lotExplorerResult.globalStock && (
                    <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                      El saldo global ({lotExplorerResult.globalStock}) no coincide con la existencia por lotes (
                      {lotExplorerResult.totalAvailable}).
                      {lotExplorerResult.initialized
                        ? ' Revise la integridad del medicamento.'
                        : ' Este medicamento aun no esta inicializado, por lo que solo se contabilizan los ingresos con lote.'}
                    </p>
                  )}
                  <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-500 grid grid-cols-12 gap-2">
                      <div className="col-span-3">Lote</div>
                      <div className="col-span-2">Expira</div>
                      <div className="col-span-3">Estado</div>
                      <div className="col-span-2 text-right">Recibido / Usado</div>
                      <div className="col-span-2 text-right">Disponible</div>
                    </div>
                    <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                      {lotExplorerResult.lots
                        .filter((lot) => lotExplorerShowDepleted || lot.availableQuantity > 0)
                        .map((lot) => {
                          const daysLeft = getDaysUntilExpiration(lot.expirationDate);
                          const expiringSoon = !lot.expired && daysLeft !== null && daysLeft <= 90;
                          return (
                            <div key={lot.sourceTransactionId} className="px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs">
                              <div className="col-span-3 min-w-0">
                                <p className="font-bold text-slate-800 truncate">{lot.lotNumber}</p>
                                <p className="text-[10px] text-slate-500">
                                  {lot.isLotInitialization ? 'Carga inicial' : lot.isLotAdjustment ? 'Ajuste manual' : 'Ingreso'}
                                </p>
                              </div>
                              <div className="col-span-2 font-semibold text-slate-700">{formatLotExpirationDate(lot.expirationDate)}</div>
                              <div className="col-span-3">
                                <span
                                  className={`text-[9px] font-bold uppercase rounded border px-2 py-1 ${
                                    lot.expired
                                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                                      : expiringSoon
                                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                                        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  }`}
                                >
                                  {lot.expired
                                    ? `Vencido hace ${Math.abs(daysLeft ?? 0)} d`
                                    : daysLeft === 0
                                      ? 'Vence hoy'
                                      : `Vence en ${daysLeft} d`}
                                </span>
                              </div>
                              <div className="col-span-2 text-right text-slate-600">
                                {lot.receivedQuantity} / {lot.usedQuantity}
                              </div>
                              <div className={`col-span-2 text-right font-bold ${lot.availableQuantity > 0 ? 'text-slate-800' : 'text-slate-400'}`}>
                                {lot.availableQuantity}
                              </div>
                            </div>
                          );
                        })}
                      {lotExplorerResult.lots.filter((lot) => lotExplorerShowDepleted || lot.availableQuantity > 0).length === 0 && (
                        <p className="px-3 py-4 text-[10px] text-slate-400">
                          Este medicamento no tiene lotes con trazabilidad registrada.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <h3 className="font-bold text-slate-800 text-sm">Ajuste Manual de Saldo</h3>
              <p className="text-xs text-slate-500 mt-1">
                Corrige el saldo base de un medicamento. En los medicamentos con lotes inicializados el ajuste tambien
                restablece lotes y fechas de expiracion, para que saldo y trazabilidad queden cuadrados.
              </p>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <SelectLabel
                  label="Medicamento"
                  name="adjustMedId"
                  options={sortedMedications.map((m) => ({ value: m.id, label: m.name }))}
                  isObject
                  value={adjustMedId}
                  onChange={(e) => {
                    setAdjustMedId(e.target.value);
                    resetAdjustLotState();
                  }}
                />
                {!lotInitializationByMedId[adjustMedId]?.completed && (
                  <InputLabel
                    label="Nuevo Saldo"
                    name="adjustBalance"
                    type="number"
                    min="0"
                    value={adjustBalanceValue}
                    onChange={(e) => setAdjustBalanceValue(e.target.value)}
                  />
                )}
                <SelectLabel
                  label="Farmaceutico"
                  name="adjustPharmacist"
                  options={pharmacists}
                  value={adjustPharmacist}
                  onChange={(e) => setAdjustPharmacist(e.target.value)}
                />
                {lotInitializationByMedId[adjustMedId]?.completed ? (
                  <button
                    type="button"
                    onClick={() => loadAdjustLotContext(adjustMedId)}
                    disabled={adjustLotLoading || adjustLotSaving}
                    className="bg-slate-900 text-white px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {adjustLotLoading ? 'Cargando...' : adjustLotContext ? 'Recargar Existencias' : 'Cargar Existencias'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={applyManualBalanceAdjustment}
                    className="bg-amber-600 text-white px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-amber-700"
                  >
                    Aplicar Ajuste
                  </button>
                )}
              </div>
              {lotInitializationByMedId[adjustMedId]?.completed && !adjustLotContext && (
                <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  Este medicamento usa lotes. Cargue las existencias actuales para hacer un recuento o corregir un lote.
                </p>
              )}
              {lotInitializationByMedId[adjustMedId]?.completed && adjustLotContext?.medId === adjustMedId && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex gap-2">
                      {[
                        { key: 'recuento', label: 'Recuento de existencias' },
                        { key: 'correccion', label: 'Corregir lote o expira' },
                      ].map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          onClick={() => setAdjustLotMode(mode.key)}
                          className={`text-[10px] font-bold uppercase tracking-wider rounded-lg border px-3 py-2 ${
                            adjustLotMode === mode.key
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] font-bold uppercase text-slate-500">
                      Saldo actual {adjustLotContext.globalStock} · Lotes {adjustLotContext.lotStock}
                    </p>
                  </div>

                  {adjustLotMode === 'recuento' && (
                    <div className="mt-4">
                      <p className="text-xs text-slate-500">
                        Declare los lotes que existen fisicamente. La suma pasa a ser el saldo del medicamento y lo anterior
                        se libera. Sin filas, el ajuste lleva el saldo a cero y no pide lote ni expiracion.
                      </p>
                      {adjustLotContext.lots.length > adjustLotContext.condensedCount && (
                        <p className="mt-2 text-[10px] font-semibold uppercase text-slate-500">
                          {adjustLotContext.lots.length} ingreso(s) agrupados en {adjustLotContext.condensedCount} lote(s)
                          fisico(s) por numero y expiracion
                        </p>
                      )}
                      <div className="mt-3 space-y-2">
                        {adjustLotRows.map((row, index) => (
                          <div key={index} className="grid grid-cols-12 gap-2 items-end">
                            <div className="col-span-5">
                              <InputLabel
                                label="Lote"
                                name={`adjustLotNumber-${index}`}
                                value={row.lotNumber}
                                onInput={forceUppercaseInput}
                                onChange={(e) =>
                                  setAdjustLotRows((prev) =>
                                    prev.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, lotNumber: e.target.value.toUpperCase() } : item,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="col-span-4">
                              <InputLabel
                                label="Expira"
                                name={`adjustLotExpiration-${index}`}
                                type="date"
                                value={row.expirationDate}
                                onChange={(e) =>
                                  setAdjustLotRows((prev) =>
                                    prev.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, expirationDate: e.target.value } : item,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="col-span-2">
                              <InputLabel
                                label="Cantidad"
                                name={`adjustLotQuantity-${index}`}
                                type="number"
                                min="1"
                                value={row.quantity}
                                onChange={(e) =>
                                  setAdjustLotRows((prev) =>
                                    prev.map((item, itemIndex) =>
                                      itemIndex === index ? { ...item, quantity: e.target.value } : item,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => setAdjustLotRows((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
                              className="col-span-1 h-[46px] rounded-lg border border-rose-200 bg-rose-50 text-[10px] font-bold uppercase text-rose-700 hover:bg-rose-100"
                            >
                              Quitar
                            </button>
                          </div>
                        ))}
                        {adjustLotRows.length === 0 && (
                          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                            Sin lotes declarados: el ajuste llevara el saldo a cero y liberara las{' '}
                            {adjustLotContext.lotStock} unidad(es) registradas.
                          </p>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setAdjustLotRows((prev) => [...prev, { lotNumber: '', expirationDate: '', quantity: '' }])
                          }
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold uppercase text-slate-600 hover:bg-slate-100"
                        >
                          Agregar lote
                        </button>
                        <button
                          type="button"
                          onClick={() => setAdjustLotRows([])}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-bold uppercase text-slate-600 hover:bg-slate-100"
                        >
                          Vaciar (llevar a cero)
                        </button>
                        <span className="text-[10px] font-bold uppercase text-slate-500">
                          Saldo resultante: {adjustRecountTotal} · Diferencia:{' '}
                          <span className={adjustRecountTotal === adjustLotContext.globalStock ? 'text-slate-500' : 'text-amber-700'}>
                            {adjustRecountTotal - adjustLotContext.globalStock > 0 ? '+' : ''}
                            {adjustRecountTotal - adjustLotContext.globalStock}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={applyLotRecount}
                          disabled={adjustLotSaving || adjustLotLoading}
                          className="ml-auto bg-amber-600 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {adjustLotSaving ? 'Aplicando...' : 'Aplicar Recuento'}
                        </button>
                      </div>
                    </div>
                  )}

                  {adjustLotMode === 'correccion' && (
                    <div className="mt-4">
                      <p className="text-xs text-slate-500">
                        Corrige el numero de lote o la fecha de expiracion sin tocar cantidades. Los egresos ya asignados a
                        ese lote se actualizan tambien, para que el Kardex historico no conserve el dato erroneo.
                      </p>
                      {adjustLotContext.lots.length === 0 ? (
                        <p className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500">
                          Este medicamento no tiene lotes con existencia para corregir.
                        </p>
                      ) : (
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                          <div className="md:col-span-2">
                            <SelectLabel
                              label="Lote a corregir"
                              name="adjustCorrectionSourceId"
                              isObject
                              options={adjustLotContext.lots.map((lot) => ({
                                value: lot.sourceTransactionId,
                                label: `${lot.lotNumber} · ${formatLotExpirationDate(lot.expirationDate)} · ${lot.availableQuantity} u`,
                              }))}
                              value={adjustCorrectionSourceId}
                              onChange={(e) => {
                                const lot = adjustLotContext.lots.find((item) => item.sourceTransactionId === e.target.value);
                                setAdjustCorrectionSourceId(e.target.value);
                                setAdjustCorrectionLotNumber(lot?.lotNumber || '');
                                setAdjustCorrectionExpirationDate(lot?.expirationDate || '');
                              }}
                            />
                          </div>
                          <InputLabel
                            label="Lote corregido"
                            name="adjustCorrectionLotNumber"
                            value={adjustCorrectionLotNumber}
                            onInput={forceUppercaseInput}
                            onChange={(e) => setAdjustCorrectionLotNumber(e.target.value.toUpperCase())}
                          />
                          <InputLabel
                            label="Expira corregida"
                            name="adjustCorrectionExpirationDate"
                            type="date"
                            value={adjustCorrectionExpirationDate}
                            onChange={(e) => setAdjustCorrectionExpirationDate(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={applyLotCorrection}
                            disabled={adjustLotSaving || adjustLotLoading}
                            className="md:col-start-4 bg-amber-600 text-white px-4 py-3 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {adjustLotSaving ? 'Aplicando...' : 'Aplicar Correccion'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
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
      {observationView && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
              <FileText size={16} className="text-amber-500" />
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Observacion</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{observationView.observacion}</p>
              <div className="border-t border-slate-100 pt-3">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Registrado por</p>
                <p className="text-xs font-bold text-slate-700 mt-0.5">{observationView.pharmacist || 'N/A'}</p>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setObservationView(null)}
                  className="bg-slate-900 text-white px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-slate-800"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Simplified Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl w-full max-w-xl max-h-[90vh] shadow-2xl overflow-y-auto border border-slate-200">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-slate-800 uppercase tracking-tight text-sm">
                {modalType === 'lot-initialization'
                  ? 'Inicializacion de Lotes'
                  : modalType === 'auditoria'
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
                  setLotInitializationMedId('');
                  setLotInitializationRows([]);
                  setLotInitializationPharmacist('');
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
              {modalType === 'lot-initialization' ? (
                <>
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                    <p className="text-[10px] font-bold uppercase text-blue-700">Medicamento</p>
                    <p className="mt-1 text-sm font-bold text-slate-800">
                      {medications.find((med) => med.id === lotInitializationMedId)?.name || lotInitializationMedId}
                    </p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-md bg-white p-2">
                        <p className="text-[9px] font-bold uppercase text-slate-500">Saldo</p>
                        <p className="text-sm font-bold text-slate-800">{lotInitializationTargetStock}</p>
                      </div>
                      <div className="rounded-md bg-white p-2">
                        <p className="text-[9px] font-bold uppercase text-slate-500">Distribuido</p>
                        <p className="text-sm font-bold text-slate-800">{lotInitializationValidation.total}</p>
                      </div>
                      <div className="rounded-md bg-white p-2">
                        <p className="text-[9px] font-bold uppercase text-slate-500">Diferencia</p>
                        <p className={`text-sm font-bold ${lotInitializationValidation.difference === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {lotInitializationValidation.difference}
                        </p>
                      </div>
                    </div>
                  </div>

                  {lotInitializationTargetStock === 0 ? (
                    <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      Este medicamento no tiene saldo. Puede confirmar la inicializacion sin agregar lotes.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {lotInitializationRows.map((row, index) => (
                        <div key={row.id || index} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <p className="text-[10px] font-bold uppercase text-slate-600">Lote {index + 1}</p>
                            <button
                              type="button"
                              onClick={() => setLotInitializationRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}
                              className="text-[9px] font-bold uppercase text-rose-600 hover:text-rose-700"
                            >
                              Eliminar
                            </button>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <InputLabel
                              label="Numero de lote"
                              name={`initialLotNumber-${index}`}
                              required
                              value={row.lotNumber}
                              onChange={(event) => updateLotInitializationRow(index, 'lotNumber', event.target.value.toUpperCase())}
                              className="uppercase"
                            />
                            <InputLabel
                              label="Expira"
                              name={`initialExpiration-${index}`}
                              type="date"
                              required
                              value={row.expirationDate}
                              onChange={(event) => updateLotInitializationRow(index, 'expirationDate', event.target.value)}
                            />
                            <InputLabel
                              label="Cantidad"
                              name={`initialAmount-${index}`}
                              type="number"
                              min="1"
                              step="1"
                              required
                              value={row.quantity}
                              onChange={(event) => updateLotInitializationRow(index, 'quantity', event.target.value)}
                            />
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setLotInitializationRows((rows) => [...rows, { id: crypto.randomUUID(), lotNumber: '', expirationDate: '', quantity: '' }])}
                        className="w-full rounded-lg border border-dashed border-blue-300 py-2 text-[10px] font-bold uppercase text-blue-700 hover:bg-blue-50"
                      >
                        Agregar otro lote
                      </button>
                    </div>
                  )}

                  {!lotInitializationValidation.valid && lotInitializationValidation.errors.length > 0 && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                      {getLotInitializationErrorMessage(lotInitializationValidation.errors[0])}
                    </div>
                  )}
                  <SelectLabel
                    label="Farmaceutico responsable"
                    name="lotInitializationPharmacist"
                    options={pharmacists}
                    value={lotInitializationPharmacist}
                    onChange={(event) => setLotInitializationPharmacist(event.target.value)}
                    required
                  />
                </>
              ) : modalType === 'auditoria' || modalType === 'auditoria-edit' ? (
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
                    options={['PRIMER TURNO', 'SEGUNDO TURNO', 'TERCER TURNO', CLOSURE_24H_TURNO]}
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
                          min="1"
                          step="1"
                          required
                          readOnly={editingLotUsedQuantity > 0}
                          defaultValue={editingTransaction?.amount || ''}
                        />
                        <InputLabel
                          label="Numero de lote"
                          name="lotNumber"
                          required
                          readOnly={editingLotUsedQuantity > 0}
                          className="uppercase"
                          onInput={forceUppercaseInput}
                          defaultValue={editingTransaction?.lotNumber || ''}
                        />
                      </div>
                      <InputLabel
                        label="Fecha de expiracion"
                        name="expirationDate"
                        type="date"
                        required
                        readOnly={editingLotUsedQuantity > 0}
                        defaultValue={editingTransaction?.expirationDate || ''}
                      />
                      {editingLotUsedQuantity > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800">
                          Este ingreso ya tiene {editingLotUsedQuantity} unidades asignadas. La cantidad, el medicamento, el lote y la expiracion no pueden modificarse.
                        </div>
                      )}
                      <SelectLabel
                        label="Farmaceutico"
                        name="pharmacist"
                        options={pharmacists}
                        defaultValue={editingTransaction?.pharmacist || pharmacists[0]}
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

                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Observaciones (opcional)</label>
                        <textarea
                          name="observacion"
                          rows={2}
                          defaultValue={transactions.find((t) => t.id === editingTransactionId)?.observacion || ''}
                          placeholder="Notas adicionales sobre este movimiento..."
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-600 outline-none font-medium uppercase resize-none"
                        />
                      </div>

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
                  <div className="grid grid-cols-2 gap-4">
                    <InputLabel
                      label="Numero de lote"
                      name="lotNumber"
                      className="uppercase"
                      onInput={forceUppercaseInput}
                      required
                    />
                    <InputLabel label="Fecha de expiracion" name="expirationDate" type="date" required />
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
                              const okDel = enqueueWrite({ type: 'delete', collection: 'catalog_services', id: toCatalogId(name) });
                              if (!okDel) {
                                notifyWriteFailed('la eliminacion del servicio');
                                return;
                              }
                              setServices(services.filter((s) => s !== name));
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
                              const okDel = enqueueWrite({ type: 'delete', collection: 'catalog_pharmacists', id: toCatalogId(name) });
                              if (!okDel) {
                                notifyWriteFailed('la eliminacion del farmaceutico');
                                return;
                              }
                              setPharmacists(pharmacists.filter((p) => p !== name));
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
                              const okDel = enqueueWrite({ type: 'delete', collection: 'catalog_condiciones', id: toCatalogId(name) });
                              if (!okDel) {
                                notifyWriteFailed('la eliminacion de la condicion');
                                return;
                              }
                              setCondiciones(condiciones.filter((c) => c !== name));
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
                    disabled={modalType === 'lot-initialization' && (lotInitializationSaving || !lotInitializationValidation.valid || !lotInitializationPharmacist)}
                    className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold text-sm shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 transition-all uppercase tracking-widest mt-4"
                  >
                    {modalType === 'lot-initialization'
                      ? lotInitializationSaving
                        ? 'Guardando...'
                        : 'Confirmar Inicializacion'
                      : 'Guardar Registro'}
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



