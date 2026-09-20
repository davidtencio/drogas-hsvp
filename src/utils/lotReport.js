// Reporte de existencias por lote.
//
// Funcion pura: recibe el resumen que ya calculo `getLotInventorySummary` con
// el historial COMPLETO de cada medicamento y arma las secciones, los totales
// y los descuadres que imprime el PDF. Vive fuera de App.jsx para poder probar
// el contenido del reporte sin React y sin jsPDF.
//
// El detalle replica la tarjeta "Ajuste Manual de Saldo": saldo actual del
// medicamento y, debajo, un renglon por lote FISICO (numero + expiracion), no
// por ingreso. Un mismo lote recibido en varias fechas es una sola existencia.
//
// Importante: quien llame debe cargar el historial completo por medicamento
// (loadAllForMed). Con la carga parcial del Kardex quedan rebajos fuera y el
// disponible por lote sale inflado.
import { compareLotsFEFO, condenseLotsByIdentity, getDaysUntilExpiration, isLotExpired } from './lots';

// Mismo umbral que usa la tarjeta "Lotes y Expiraciones Disponibles" para
// pintar en ambar un lote proximo a vencer. Si cambia alla, cambiar aqui.
export const EXPIRING_SOON_DAYS = 90;

export const buildLotStockReport = (entries, { includeDepleted = false, asOf = new Date() } = {}) => {
  const sections = (entries || []).map((entry) => {
    const summary = entry?.summary;
    // Ordenar ANTES de condensar mantiene el orden FEFO en el resultado.
    const origins = [...(summary?.lots || [])]
      .sort(compareLotsFEFO)
      .filter((lot) => includeDepleted || lot.availableQuantity > 0);
    const lots = condenseLotsByIdentity(origins).map((lot) => {
      const daysLeft = getDaysUntilExpiration(lot.expirationDate, asOf);
      const expired = isLotExpired(lot.expirationDate, asOf);
      return {
        lotNumber: lot.lotNumber,
        expirationDate: lot.expirationDate,
        quantity: lot.quantity,
        originCount: lot.originCount,
        expired,
        daysLeft,
        expiringSoon: !expired && daysLeft !== null && daysLeft <= EXPIRING_SOON_DAYS,
      };
    });
    const globalStock = Number(entry?.globalStock) || 0;
    const totalAvailable = Number(summary?.totalAvailable) || 0;
    const failed = Boolean(entry?.failed);
    return {
      medId: entry?.medId,
      medName: entry?.medName || entry?.medId || '',
      initialized: Boolean(entry?.initialized),
      failed,
      globalStock,
      totalAvailable,
      usableAvailable: Number(summary?.usableAvailable) || 0,
      expiredAvailable: Number(summary?.expiredAvailable) || 0,
      lotCount: lots.filter((lot) => lot.quantity > 0).length,
      originCount: origins.length,
      // Un medicamento que no se pudo cargar no se declara cuadrado: sin
      // historial confirmado el 0 = 0 seria una coincidencia enganosa.
      matches: !failed && globalStock === totalAvailable,
      lots,
    };
  });

  const totals = sections.reduce(
    (acc, section) => {
      if (section.failed) {
        acc.failures += 1;
        return acc;
      }
      acc.globalStock += section.globalStock;
      acc.available += section.totalAvailable;
      acc.usable += section.usableAvailable;
      acc.expired += section.expiredAvailable;
      acc.lots += section.lotCount;
      if (!section.matches) acc.mismatches += 1;
      section.lots.forEach((lot) => {
        if (lot.quantity <= 0) return;
        if (lot.expired) acc.expiredLots += 1;
        else if (lot.expiringSoon) acc.expiringSoonLots += 1;
      });
      return acc;
    },
    {
      medications: sections.length,
      globalStock: 0,
      available: 0,
      usable: 0,
      expired: 0,
      lots: 0,
      expiredLots: 0,
      expiringSoonLots: 0,
      mismatches: 0,
      failures: 0,
    },
  );

  return { sections, totals };
};

// Etiqueta de estado del lote, igual a la que muestra la tarjeta en pantalla.
export const formatLotStatus = (lot) => {
  if (lot?.daysLeft === null || lot?.daysLeft === undefined) return 'Sin fecha';
  if (lot.expired) return `Vencido hace ${Math.abs(lot.daysLeft)} d`;
  if (lot.daysLeft === 0) return 'Vence hoy';
  return `Vence en ${lot.daysLeft} d`;
};
