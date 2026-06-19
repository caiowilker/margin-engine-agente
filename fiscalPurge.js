// Purge automático SQLite + arquivos fiscais
const filaFiscal = require("./filaFiscal");
const fila = require("./fila");
const fiscalStorage = require("./fiscalStorage");
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "fiscal_purge" });

const DIAS_FILA_FISCAL = parseInt(process.env.FISCAL_PURGE_FILA_DIAS || "30", 10);
const DIAS_RESULTADOS = parseInt(process.env.FISCAL_PURGE_RESULTADOS_DIAS || "180", 10);
const DIAS_FILA_VENDAS = parseInt(process.env.FISCAL_PURGE_VENDAS_DIAS || "30", 10);
const DIAS_XML = parseInt(process.env.FISCAL_PURGE_XML_DIAS || "180", 10);
const DIAS_PDF = parseInt(process.env.FISCAL_PURGE_PDF_DIAS || "180", 10);
const DIAS_DOCUMENTOS = parseInt(process.env.FISCAL_PURGE_DOCUMENTOS_DIAS || "180", 10);
const DIAS_BACKUP = parseInt(process.env.FISCAL_PURGE_BACKUP_DIAS || "90", 10);
const DIAS_AUDIT = parseInt(process.env.AUDIT_RETENCAO_DIAS || "90", 10);
const INTERVAL_MS = parseInt(
  process.env.FISCAL_PURGE_INTERVAL_MS || String(6 * 3600 * 1000),
  10,
);

let timer = null;

function executarPurge() {
  try {
    const r1 = filaFiscal.purgeAntigos(DIAS_FILA_FISCAL, DIAS_RESULTADOS, DIAS_DOCUMENTOS);
    const r2 =
      typeof fila.purgeAntigos === "function"
        ? fila.purgeAntigos(DIAS_FILA_VENDAS)
        : { removidos: 0 };
    const r3 = fiscalStorage.purgeArquivos(DIAS_XML, DIAS_PDF, DIAS_BACKUP);
    const r4 = auditLog.purgeAntigos(DIAS_AUDIT);
    log.info(
      { filaFiscal: r1, filaVendas: r2, arquivos: r3, audit: r4 },
      "Purge concluído",
    );
    return { filaFiscal: r1, filaVendas: r2, arquivos: r3, audit: r4 };
  } catch (err) {
    log.error({ err: err.message }, "Purge falhou");
    return { erro: err.message };
  }
}

function iniciar() {
  if (timer) return;
  setTimeout(executarPurge, 60000);
  timer = setInterval(executarPurge, INTERVAL_MS);
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { executarPurge, iniciar, parar };
