export const getBackupSummary = ({
  medications = [], transactions = [], expedientes = [], bitacora = [],
  services = [], pharmacists = [], condiciones = [],
} = {}) => ({
  medications: medications.length,
  transactions: transactions.length,
  expedientes: expedientes.length,
  bitacora: bitacora.length,
  services: services.length,
  pharmacists: pharmacists.length,
  condiciones: condiciones.length,
});

export const getBackupChecksumSource = (summary, selectedMedId, maxRecords) =>
  `${summary.medications}|${summary.transactions}|${summary.expedientes}|${summary.bitacora}|${summary.services}|${summary.pharmacists}|${summary.condiciones}|${selectedMedId}|${maxRecords}`;
