// Render del reporte PDF de existencias por lote.
//
// Vive fuera de App.jsx para no engrosar mas el componente y para que el
// contenido (lotReport.js) quede separado de la presentacion. jsPDF se importa
// dinamicamente, igual que en la solicitud de reposicion, para no cargarlo en
// el arranque de la aplicacion.
import { formatLotExpirationDate } from './lots';
import { formatLotStatus } from './lotReport';

const CR_TIMEZONE = 'America/Costa_Rica';

// Paleta de la aplicacion (Tailwind) para que el PDF y la pantalla cuenten lo
// mismo: emerald vigente, amber por vencer, rose vencido o descuadrado.
const EMERALD = [22, 163, 74];
const EMERALD_TEXT = [4, 120, 87];
const AMBER_TEXT = [180, 83, 9];
const ROSE_TEXT = [190, 18, 60];
const ROSE_BG = [255, 241, 242];
const SLATE_BG = [241, 245, 249];
const SLATE_TEXT = [30, 41, 59];
const SLATE_MUTED = [100, 116, 139];

// Filas del detalle: una fila de grupo por medicamento con su saldo actual y
// debajo un renglon por lote FISICO en orden FEFO, como la tarjeta "Ajuste
// Manual de Saldo". "Ingresos" dice cuantos ingresos se agruparon en ese lote.
export const buildLotReportTableBody = (report) => {
  const body = [];
  (report?.sections || []).forEach((section) => {
    const flagged = section.failed || !section.matches;
    body.push([
      {
        content: section.failed
          ? `${section.medName}   -   no se pudo cargar el historial completo`
          : `${section.medName}   -   Saldo actual: ${section.globalStock}   -   Lotes: ${section.totalAvailable}` +
            `   -   Vigente: ${section.usableAvailable}   -   Vencido: ${section.expiredAvailable}`,
        colSpan: 5,
        styles: {
          fontStyle: 'bold',
          fillColor: flagged ? ROSE_BG : SLATE_BG,
          textColor: flagged ? ROSE_TEXT : SLATE_TEXT,
          halign: 'left',
        },
      },
    ]);
    if (section.failed) return;
    if (section.lots.length === 0) {
      body.push([
        {
          content: section.initialized
            ? 'Sin lotes con existencia.'
            : 'Sin trazabilidad de lote: medicamento no inicializado.',
          colSpan: 5,
          styles: { textColor: SLATE_MUTED, fontStyle: 'italic', halign: 'left' },
        },
      ]);
      return;
    }
    section.lots.forEach((lot) => {
      body.push([
        lot.lotNumber,
        formatLotExpirationDate(lot.expirationDate),
        {
          content: formatLotStatus(lot),
          styles: {
            fontStyle: 'bold',
            textColor: lot.expired ? ROSE_TEXT : lot.expiringSoon ? AMBER_TEXT : EMERALD_TEXT,
          },
        },
        lot.originCount,
        lot.quantity,
      ]);
    });
  });
  return body;
};

export const downloadLotStockReportPDF = async ({
  report,
  generatedBy = '',
  includeDepleted = false,
  pendingCount = 0,
  fileName = `existencias_lotes_${Date.now()}.pdf`,
} = {}) => {
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
  const totals = report?.totals || {};

  // Encabezado institucional, igual al de la solicitud de reposicion.
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('HOSPITAL SAN VICENTE DE PAUL', 105, 15, { align: 'center' });
  doc.setFontSize(12);
  doc.text('CONTROL DE DROGAS Y ESTUPEFACIENTES', 105, 22, { align: 'center' });
  doc.setFontSize(14);
  doc.text('EXISTENCIAS POR MEDICAMENTO Y LOTE', 105, 32, { align: 'center' });

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Fecha y Hora: ${now}`, 14, 42);
  doc.text(`Generado por: ${generatedBy || 'N/A'}`, 14, 48);
  doc.text(
    `Alcance: ${totals.medications || 0} medicamento(s) con lotes inicializados, ${
      includeDepleted ? 'incluye lotes agotados' : 'solo lotes con existencia'
    }`,
    14,
    54,
  );

  autoTable(doc, {
    startY: 60,
    head: [['Lotes', 'Saldo actual', 'En lotes', 'Vigente', 'Vencido', 'Descuadres']],
    body: [
      [
        totals.lots || 0,
        totals.globalStock || 0,
        totals.available || 0,
        totals.usable || 0,
        totals.expired || 0,
        totals.mismatches || 0,
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: EMERALD, halign: 'center', valign: 'middle' },
    styles: { fontSize: 10, cellPadding: 3, halign: 'center' },
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    head: [['Lote', 'Expira', 'Estado', 'Ingresos', 'Existencia']],
    body: buildLotReportTableBody(report),
    theme: 'grid',
    headStyles: { fillColor: EMERALD, halign: 'center', valign: 'middle' },
    styles: { fontSize: 8.5, cellPadding: 2, textColor: SLATE_TEXT, overflow: 'linebreak' },
    // Sin anchos fijos: autoTable reparte el ancho segun el contenido, que es
    // lo unico que tolera numeros de lote largos sin desbordar la pagina.
    columnStyles: {
      0: { fontStyle: 'bold' },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
    },
  });

  const pageHeight = doc.internal.pageSize.getHeight();
  let cursorY = doc.lastAutoTable.finalY + 10;
  const ensureSpace = (needed) => {
    if (cursorY + needed <= pageHeight - 20) return;
    doc.addPage();
    cursorY = 20;
  };
  const warn = (message) => {
    ensureSpace(10);
    doc.setFontSize(9);
    doc.setTextColor(ROSE_TEXT[0], ROSE_TEXT[1], ROSE_TEXT[2]);
    doc.text(message, 14, cursorY);
    cursorY += 6;
  };

  // Advertencias: un reporte incompleto o descuadrado debe decirlo en el papel,
  // no solo en pantalla.
  if (totals.failures > 0) {
    warn(`${totals.failures} medicamento(s) sin historial confirmado: el reporte esta incompleto.`);
  }
  if (totals.mismatches > 0) {
    warn(`${totals.mismatches} medicamento(s) con saldo actual distinto a la existencia por lotes.`);
  }
  if (pendingCount > 0) {
    warn(`${pendingCount} movimiento(s) pendientes de sincronizar al momento de generar el reporte.`);
  }
  doc.setTextColor(SLATE_TEXT[0], SLATE_TEXT[1], SLATE_TEXT[2]);

  ensureSpace(40);
  const signatureY = cursorY + 30;
  doc.setFontSize(10);
  doc.line(20, signatureY, 80, signatureY);
  doc.text('Elaborado por', 50, signatureY + 5, { align: 'center' });
  doc.line(130, signatureY, 190, signatureY);
  doc.text('Revisado por', 160, signatureY + 5, { align: 'center' });

  const pageCount = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(SLATE_MUTED[0], SLATE_MUTED[1], SLATE_MUTED[2]);
    doc.text(`Pagina ${page} de ${pageCount}`, 196, pageHeight - 10, { align: 'right' });
  }

  doc.save(fileName);
  return doc;
};
