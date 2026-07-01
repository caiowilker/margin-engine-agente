// Relatório diário fiscal — fiscal_metrics.db + fila_fiscal.db + audit.db
const path = require("path");
const Database = require("better-sqlite3");
const fiscalMetrics = require("./fiscalMetrics");
const { getDirectoryManager } = require("./runtime/directoryManager");

function openDb(relative) {
  const fp = getDirectoryManager().file("agent", relative);
  if (!require("fs").existsSync(fp)) return null;
  return new Database(fp, { readonly: true });
}

function gerarRelatorio(dataStr) {
  const data = dataStr || new Date().toISOString().slice(0, 10);
  fiscalMetrics.init();

  const metricsDb = fiscalMetrics.getDb();
  const fiscalDb = openDb("fila_fiscal.db");
  const auditDb = openDb("audit.db");

  let total = 0;
  let tempoMedio = 0;
  let piorTempo = 0;
  let pdfSalvos = 0;

  if (metricsDb) {
    total =
      metricsDb
        .prepare(
          `SELECT COUNT(*) as n FROM metric_samples
           WHERE tipo = 'emission' AND date(criado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    const tempoRow = metricsDb
      .prepare(
        `SELECT AVG(valor_ms) as media, MAX(valor_ms) as pior
         FROM metric_samples WHERE tipo = 'emission' AND date(criado_em) = date(?)`,
      )
      .get(data);
    tempoMedio = Math.round(tempoRow?.media || 0);
    piorTempo = Math.round(tempoRow?.pior || 0);
    pdfSalvos =
      metricsDb
        .prepare(
          `SELECT COUNT(*) as n FROM metric_samples
           WHERE tipo = 'pdf' AND date(criado_em) = date(?)`,
        )
        .get(data)?.n || 0;
  }

  let sucesso = 0;
  let falhaPermanente = 0;
  let recuperadas = 0;

  if (fiscalDb) {
    sucesso =
      fiscalDb
        .prepare(
          `SELECT COUNT(*) as n FROM emissao_resultados
           WHERE status IN ('CONCLUIDO','CONCLUIDO_RECUPERADO') AND date(atualizado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    falhaPermanente =
      fiscalDb
        .prepare(
          `SELECT COUNT(*) as n FROM emissao_resultados
           WHERE status = 'FALHA_PERMANENTE' AND date(atualizado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    recuperadas =
      fiscalDb
        .prepare(
          `SELECT COUNT(*) as n FROM emissao_resultados
           WHERE status = 'CONCLUIDO_RECUPERADO' AND date(atualizado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    if (!total) total = sucesso + falhaPermanente;
    fiscalDb.close();
  }

  let incidentesAcbr = 0;
  let alertasDispatchados = 0;
  if (auditDb) {
    incidentesAcbr =
      auditDb
        .prepare(
          `SELECT COUNT(*) as n FROM audit_log
           WHERE acao = 'ACBR_STATUS_OFFLINE' AND date(criado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    alertasDispatchados =
      auditDb
        .prepare(
          `SELECT COUNT(*) as n FROM audit_log
           WHERE acao = 'WEBHOOK_ALERTA_OK' AND date(criado_em) = date(?)`,
        )
        .get(data)?.n || 0;
    auditDb.close();
  }

  const taxa =
    total > 0 ? Math.round((sucesso / total) * 1000) / 10 : sucesso > 0 ? 100 : 0;

  return {
    data,
    emissoes: {
      total,
      sucesso,
      falhaPermanente,
      recuperadas,
      taxaSucessoPercent: taxa,
    },
    tempoMedioEmissaoMs: tempoMedio,
    piorTempoEmissaoMs: piorTempo,
    incidentesAcbr,
    alertasDispatchados,
    xmlSalvos: sucesso,
    pdfSalvos,
  };
}

module.exports = { gerarRelatorio };
