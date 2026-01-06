import React, { useState, useMemo, useEffect } from 'react';
import { Upload, FileSpreadsheet, CheckCircle, Circle, Save, Printer, Search, AlertCircle, RefreshCw, FileText, Settings, Plus, X, User, Building, Clock, Users } from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Modal de Configuración sencilla
const SettingsModal = ({ isOpen, onClose, pharmacists, setPharmacists, halls, setHalls }) => {
  const [newPharm, setNewPharm] = useState('');
  const [newHall, setNewHall] = useState('');

  if (!isOpen) return null;

  const addPharm = () => {
    if (newPharm.trim()) {
      setPharmacists([...pharmacists, newPharm.trim()]);
      setNewPharm('');
    }
  };

  const removePharm = (index) => {
    const newList = [...pharmacists];
    newList.splice(index, 1);
    setPharmacists(newList);
  };

  const addHall = () => {
    if (newHall.trim()) {
      setHalls([...halls, newHall.trim()]);
      setNewHall('');
    }
  };

  const removeHall = (index) => {
    const newList = [...halls];
    newList.splice(index, 1);
    setHalls(newList);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Settings className="w-5 h-5 text-gray-500" />
            Configuración de Catálogos
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 grid md:grid-cols-2 gap-8">
          {/* Farmacéuticos */}
          <div>
            <h3 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <User className="w-4 h-4 text-blue-500" />
              Farmacéuticos
            </h3>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newPharm}
                onChange={(e) => setNewPharm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPharm()}
                placeholder="Nombre del farmacéutico"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={addPharm}
                className="bg-blue-600 text-white p-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
            <ul className="space-y-2 max-h-60 overflow-y-auto pr-2">
              {pharmacists.map((ph, idx) => (
                <li key={idx} className="flex justify-between items-center bg-gray-50 px-3 py-2 rounded text-sm group">
                  <span>{ph}</span>
                  <button onClick={() => removePharm(idx)} className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
              {pharmacists.length === 0 && <p className="text-xs text-gray-400 italic">No hay registros</p>}
            </ul>
          </div>

          {/* Salones */}
          <div>
            <h3 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <Building className="w-4 h-4 text-green-500" />
              Salones de Internamiento
            </h3>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newHall}
                onChange={(e) => setNewHall(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addHall()}
                placeholder="Nombre del salón (ej. Cirugía)"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={addHall}
                className="bg-green-600 text-white p-2 rounded-lg hover:bg-green-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
            <ul className="space-y-2 max-h-60 overflow-y-auto pr-2">
              {halls.map((h, idx) => (
                <li key={idx} className="flex justify-between items-center bg-gray-50 px-3 py-2 rounded text-sm group">
                  <span>{h}</span>
                  <button onClick={() => removeHall(idx)} className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
              {halls.length === 0 && <p className="text-xs text-gray-400 italic">No hay registros</p>}
            </ul>
          </div>
        </div>

        <div className="p-6 bg-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Listo
          </button>
        </div>
      </div>
    </div>
  );
};

const App = () => {
  const [data, setData] = useState([]);
  const [fileName, setFileName] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // State for config
  const [showSettings, setShowSettings] = useState(false);

  // Persisted state via localStorage initialization
  const [pharmacists, setPharmacists] = useState(() => {
    const saved = localStorage.getItem('pharmacists');
    return saved ? JSON.parse(saved) : [];
  });
  const [halls, setHalls] = useState(() => {
    const saved = localStorage.getItem('halls');
    return saved ? JSON.parse(saved) : [];
  });

  // Session state for selections
  const [selectedPharmacist, setSelectedPharmacist] = useState('');
  const [selectedHall, setSelectedHall] = useState('');
  const [dispatchDuration, setDispatchDuration] = useState('24'); // 24, 48, 72

  // Effects to save catalogs
  useEffect(() => {
    localStorage.setItem('pharmacists', JSON.stringify(pharmacists));
  }, [pharmacists]);

  useEffect(() => {
    localStorage.setItem('halls', JSON.stringify(halls));
  }, [halls]);


  // Helper para limpiar valores extraídos de celdas
  const cleanVal = (val) => {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  };

  const processExcelData = (dataRows) => {
    const parsedData = [];

    let currentPatient = null;
    let currentId = null;
    let currentBed = null;

    dataRows.forEach((row, index) => {
      // row es un array de valores [col0, col1, col2, ...]
      if (!row || row.length === 0) return;

      // Primera columna normalizada
      const firstCol = cleanVal(row[0]).toUpperCase();

      // 1. Detectar Paciente
      // Aceptamos 'PACIENTE' en la primera columna
      if (firstCol === 'PACIENTE') {
        // Cédula: columna 1 (index 1)
        currentId = cleanVal(row[1]).replace('.0', '');

        // Nombre: columna 2 (index 2)
        currentPatient = cleanVal(row[2]) || 'Desconocido';

        // Cama: buscamos la celda que tenga el label "CAMA"
        // A veces está en una columna variable. Buscamos en toda la fila.
        const bedLabelIndex = row.findIndex(cell => cleanVal(cell).toUpperCase().includes('CAMA'));

        if (bedLabelIndex !== -1 && row[bedLabelIndex + 1] !== undefined) {
          currentBed = cleanVal(row[bedLabelIndex + 1]).replace('.0', '');
        } else {
          // Fallback a índice 4 si existe (formato standard)
          currentBed = cleanVal(row[4]).replace('.0', '');
        }
        return;
      }

      // 2. Detectar Medicamentos
      // Si tenemos paciente activo y la fila tiene datos suficientes
      if (currentPatient && row.length > 2) {
        let medName = cleanVal(row[0]);
        // Limitar a 50 caracteres
        if (medName.length > 50) {
          medName = medName.substring(0, 50) + '...';
        }

        // La cantidad suele estar en la columna 3 (índice 3)
        const qtyVal = row[3];

        // Validar si es un número válido
        const potentialQty = parseFloat(qtyVal);

        const isHeader = ['PRODUCTO', 'DESCRIPCIÓN', 'DESCRIPCION'].includes(medName.toUpperCase());

        // Debe tener nombre, ser numérico positivo/cero, y no ser header
        if (!isNaN(potentialQty) && medName && !isHeader) {
          parsedData.push({
            id: crypto.randomUUID(),
            patientId: currentId,
            patientName: currentPatient,
            bed: currentBed,
            medication: medName,
            dailyQty: String(potentialQty),
            reviewed: false
          });
        }
      }
    });

    return parsedData;
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setLoading(true);
    setErrorMsg('');
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      // Leer el workbook
      const workbook = XLSX.read(buffer, { type: 'array' });

      // Asumimos que la data está en la primera hoja
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // Convertir a JSON (array de arrays) - header: 1 devuelve un array de arrays
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      const result = processExcelData(jsonData);

      if (result.length === 0) {
        setErrorMsg("Se leyó el archivo pero no se detectaron datos. Verifique que sea el reporte correcto.");
        setData([]);
      } else {
        setData(result);
      }
    } catch (error) {
      console.error("Error al procesar Excel", error);
      setErrorMsg("Error al leer el archivo. Asegúrese de que no esté dañado.");
    } finally {
      setLoading(false);
    }
  };

  const handleQtyChange = (id, newVal) => {
    setData(prev => prev.map(item =>
      item.id === id ? { ...item, dailyQty: newVal } : item
    ));
  };

  const toggleReview = (id) => {
    setData(prev => prev.map(item =>
      item.id === id ? { ...item, reviewed: !item.reviewed } : item
    ));
  };

  const exportToPDF = () => {
    const doc = new jsPDF();

    // Header Info
    const now = new Date();

    // Colores y Diseño
    doc.setFillColor(37, 99, 235); // Blue header
    doc.rect(0, 0, 210, 40, 'F');

    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    doc.text("Despacho de Medicamentos", 14, 20);

    doc.setFontSize(10);
    doc.text(`Fecha: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`, 14, 28);
    doc.text(`Duración: ${dispatchDuration} Horas`, 14, 34);

    // Metadata Right Side of Header
    doc.setFontSize(10);
    doc.text(`Salón: ${selectedHall || 'General'}`, 150, 20, { align: 'right' });
    doc.text(`Resp: ${selectedPharmacist || 'No asignado'}`, 150, 28, { align: 'right' });

    // Table
    const tableColumn = ["Cédula", "Paciente", "Cama", "Medicamento", "Cant.", "Estado"];
    const tableRows = [];

    // Filter Logic for Export if implied (using filteredData)
    // Or just all data. Let's use filteredData to respect visual filter if used
    // But typically reports want EVERYTHING. We'll use 'data'.
    const sourceData = data;

    sourceData.forEach(item => {
      const rowData = [
        item.patientId,
        item.patientName,
        item.bed,
        item.medication,
        item.dailyQty,
        item.reviewed ? "Revisado" : "Pendiente"
      ];
      tableRows.push(rowData);
    });

    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 45,
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [60, 60, 60] },
      margin: { top: 45 }
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text(`Página ${i} de ${pageCount}`, 105, 290, { align: 'center' });
    }

    doc.save(`despacho_${dispatchDuration}h_${fileName.replace(/\.[^/.]+$/, "")}.pdf`);
  };

  const resetData = () => {
    if (data.length > 0 && !confirm("¿Borrar datos actuales?")) return;
    setData([]);
    setFileName('');
    setErrorMsg('');
  };

  const filteredData = useMemo(() => {
    if (!searchTerm) return data;
    const lowerTerm = searchTerm.toLowerCase();
    return data.filter(item =>
      (item.patientName && item.patientName.toLowerCase().includes(lowerTerm)) ||
      (item.medication && item.medication.toLowerCase().includes(lowerTerm)) ||
      (item.patientId && item.patientId.includes(lowerTerm)) ||
      (item.bed && item.bed.includes(lowerTerm))
    );
  }, [data, searchTerm]);

  const totalItems = data.length;
  const reviewedItems = data.filter(i => i.reviewed).length;
  const progress = totalItems === 0 ? 0 : Math.round((reviewedItems / totalItems) * 100);

  if (data.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 font-sans">
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          pharmacists={pharmacists}
          setPharmacists={setPharmacists}
          halls={halls}
          setHalls={setHalls}
        />

        <div className="bg-white p-8 rounded-xl shadow-lg max-w-lg w-full text-center relative">
          <button
            onClick={() => setShowSettings(true)}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
            title="Configurar Catálogos"
          >
            <Settings className="w-6 h-6" />
          </button>

          <div className="bg-blue-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileSpreadsheet className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Revisión de Medicamentos</h1>
          <p className="text-gray-500 mb-6">Sube el reporte (Excel o CSV) para generar la lista de trabajo.</p>

          <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-blue-300 border-dashed rounded-lg cursor-pointer bg-blue-50 hover:bg-blue-100 transition-colors">
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              <Upload className="w-8 h-8 mb-3 text-blue-500" />
              <p className="mb-2 text-sm text-gray-500"><span className="font-semibold">Haz clic para subir</span> o arrastra el archivo</p>
              <p className="text-xs text-gray-400">Soporta reportes .xls, .xlsx y .csv</p>
            </div>
            <input type="file" className="hidden" accept=".csv,.txt,.xls,.xlsx" onChange={handleFileUpload} />
          </label>

          {loading && <p className="mt-4 text-blue-600 animate-pulse">Procesando archivo...</p>}

          {errorMsg && (
            <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2 text-left">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 font-sans text-gray-800">
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        pharmacists={pharmacists}
        setPharmacists={setPharmacists}
        halls={halls}
        setHalls={setHalls}
      />

      <header className="bg-white shadow-sm sticky top-0 z-10 p-0">
        {/* Top Bar for Action */}
        <div className="max-w-7xl mx-auto px-4 py-4 pt-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <FileSpreadsheet className="w-6 h-6 text-blue-600" />
                Control de Dosis
              </h1>
              <p className="text-sm text-gray-500">{fileName}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              {/* Controls Area */}
              <div className="bg-gray-50 rounded-lg p-1 flex gap-2 border border-gray-200">
                <select
                  value={selectedPharmacist}
                  onChange={(e) => setSelectedPharmacist(e.target.value)}
                  className="bg-white border text-sm rounded px-2 py-1 outline-none focus:border-blue-500 w-32 md:w-40"
                >
                  <option value="">Farmacéutico...</option>
                  {pharmacists.map((p, i) => <option key={i} value={p}>{p}</option>)}
                </select>

                <select
                  value={selectedHall}
                  onChange={(e) => setSelectedHall(e.target.value)}
                  className="bg-white border text-sm rounded px-2 py-1 outline-none focus:border-blue-500 w-28 md:w-36"
                >
                  <option value="">Salón...</option>
                  {halls.map((h, i) => <option key={i} value={h}>{h}</option>)}
                </select>

                <div className="flex items-center bg-white rounded border border-gray-200 mx-1">
                  {['24', '48', '72'].map((dur) => (
                    <button
                      key={dur}
                      onClick={() => setDispatchDuration(dur)}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${dispatchDuration === dur
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-600 hover:bg-gray-50'
                        } ${dur === '24' ? 'rounded-l' : ''} ${dur === '72' ? 'rounded-r' : ''}`}
                    >
                      {dur}h
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setShowSettings(true)}
                  className="p-1.5 text-gray-500 hover:bg-gray-200 rounded"
                  title="Configurar"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </div>

              <div className="h-6 w-px bg-gray-300 mx-1 hidden md:block"></div>

              <div className="flex gap-2">
                <button
                  onClick={exportToPDF}
                  className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg shadow transition-colors text-sm font-medium"
                >
                  <FileText className="w-4 h-4" />
                  <span className="hidden lg:inline">PDF</span>
                </button>

                <button
                  onClick={resetData}
                  className="p-2 bg-gray-100 hover:bg-red-100 text-gray-600 hover:text-red-600 rounded-lg transition-colors"
                  title="Reiniciar"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col md:flex-row gap-4 items-center">
            {/* Progress Bar */}
            <div className="flex-1 w-full md:w-auto">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Buscar (Filtra la tabla)..."
                  className="block w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded leading-5 bg-white placeholder-gray-400 focus:outline-none focus:border-blue-500 sm:text-sm"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            <div className="w-full md:w-48 flex items-center gap-2">
              <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="bg-green-500 h-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
              <span className="text-xs font-bold text-gray-600 w-8 text-right">{progress}%</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-16">
                    Estado
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                    Cédula
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                    Cama
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Paciente / Medicamento
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                    Cant. Diaria
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredData.map((item) => (
                  <tr
                    key={item.id}
                    className={`transition-colors hover:bg-gray-50 ${item.reviewed ? 'bg-green-50' : ''}`}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <button
                        onClick={() => toggleReview(item.id)}
                        className={`focus:outline-none transition-transform active:scale-95 ${item.reviewed ? 'text-green-600' : 'text-gray-300 hover:text-gray-400'}`}
                      >
                        {item.reviewed ? (
                          <CheckCircle className="w-6 h-6" />
                        ) : (
                          <Circle className="w-6 h-6" />
                        )}
                      </button>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {item.patientId}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-bold bg-blue-50 text-center rounded">
                      {item.bed}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-gray-500 uppercase font-semibold mb-1">{item.patientName}</div>
                      <div className="text-sm text-gray-900">{item.medication}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="text"
                        value={item.dailyQty}
                        onChange={(e) => handleQtyChange(item.id, e.target.value)}
                        className={`w-24 px-2 py-1 text-sm border rounded focus:ring-2 focus:ring-blue-500 focus:outline-none ${item.reviewed ? 'bg-green-100 border-green-300' : 'bg-white border-gray-300'
                          }`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredData.length === 0 && (
            <div className="p-8 text-center text-gray-500">
              <AlertCircle className="w-10 h-10 mx-auto mb-2 text-gray-300" />
              <p>No se encontraron resultados para tu búsqueda.</p>
            </div>
          )}
        </div>
      </main>

      <style>{`
        @media print {
          header, button, input[type="text"], .bg-gray-50.rounded-lg.p-1.flex.gap-2.border.border-gray-200 {
             display: none !important;
          }
          input[type="text"] {
             border: none;
             background: transparent;
             display: block !important;
          }
          td button { display: none; }
          tr.bg-green-50 { background-color: white !important; }
        }
      `}</style>
    </div>
  );
};

export default App;
