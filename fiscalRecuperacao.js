// Re-emissão segura — consulta SEFAZ/chave/nNF antes de reenviar
const acbr = require("./acbr");
const docs = require("./documentosFiscais");
const filaFiscal = require("./filaFiscal");
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "fiscal_recuperacao" });

const MAX_TENTATIVAS_CONSULTA = parseInt(
  process.env.MAX_TENTATIVAS_CONSULTA || "12",
  10,
);
const BACKOFF_BASE_MS = 120000;
const BACKOFF_CAP_MS = 1800000;

function calcularDelayMs(tentativasAposFalha) {
  const n = Math.max(1, tentativasAposFalha);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

function calcularProximoRetryIso(tentativasConsulta) {
  const delay = calcularDelayMs(tentativasConsulta);
  return new Date(Date.now() + delay).toISOString();
}

function acbrDisponivelMemoria() {
  if (!acbr.EMISSAO_FISCAL) return false;
  return acbr.obterStatusMemoria(false) !== "offline";
}

async function consultarDocumentoAutorizado(meta = {}) {
  const { chave, serie, numeroNfe, numeroVenda } = meta;

  if (numeroVenda) {
    const local = filaFiscal.buscarDocumentoPorVenda(numeroVenda);
    if (local?.chave && local.c_stat && ["100", "150"].includes(String(local.c_stat))) {
      return montarDeDocumentoLocal(local);
    }
    const resultado = filaFiscal.obterResultadoPorVenda(numeroVenda);
    if (
      resultado &&
      ["CONCLUIDO", "CONCLUIDO_RECUPERADO"].includes(resultado.status) &&
      resultado.resultado
    ) {
      try {
        return { ...JSON.parse(resultado.resultado), recuperado: true };
      } catch (_) {}
    }
  }

  if (chave && acbrDisponivelMemoria()) {
    try {
      const consulta = await acbr.consultarChave(chave);
      if (consulta.situacao === "AUTORIZADA") {
        return {
          fiscal: true,
          chave,
          numero: consulta.raw?.match(/Numero=(\d+)/)?.[1] || meta.numeroNfe,
          serie: consulta.raw?.match(/Serie=(\d+)/)?.[1] || meta.serieNfe || "001",
          protocolo: consulta.protocolo,
          cStat: consulta.cStat || "100",
          xMotivo: consulta.xMotivo,
          xml: docs.extrairXmlDaResposta(consulta.raw),
          recuperado: true,
        };
      }
    } catch (err) {
      log.warn({ chave, err: err.message }, "Consulta chave falhou");
      if (!acbrDisponivelMemoria()) {
        const e = new Error("ACBr offline");
        e.acbrOffline = true;
        throw e;
      }
    }
  }

  if (serie && numeroNfe) {
    const doc = filaFiscal.buscarDocumentoPorSerieNumero(serie, numeroNfe);
    if (doc?.chave) {
      return montarDeDocumentoLocal(doc);
    }
  }

  return null;
}

function montarDeDocumentoLocal(doc) {
  let xml = null;
  if (doc.xml_path && docs.lerArquivo) {
    const buf = docs.lerArquivo(doc.xml_path);
    xml = buf ? buf.toString("utf8") : null;
  }
  return {
    fiscal: true,
    chave: doc.chave,
    numero: doc.numero_nfe || null,
    serie: doc.serie_nfe || "001",
    protocolo: doc.protocolo,
    cStat: doc.c_stat || "100",
    xml,
    recuperado: true,
  };
}

async function verificarAntesDeEmitir(payload) {
  const meta = {
    chave: payload.chave || payload.chaveConsulta || payload._fiscalMeta?.chave,
    serie: payload.serieNfe || payload._fiscalMeta?.serieNfe,
    numeroNfe: payload.numeroNfe || payload._fiscalMeta?.numeroNfe,
    numeroVenda: payload.numeroVenda,
  };
  return consultarDocumentoAutorizado(meta);
}

function agendarBackoff(job, tentativasConsulta, motivo) {
  const proximo = calcularProximoRetryIso(tentativasConsulta);
  filaFiscal.agendarRetryConsulta(job.id, tentativasConsulta, proximo);
  let payload = {};
  try {
    payload = JSON.parse(job.payload);
  } catch (_) {}
  filaFiscal.salvarResultadoEmissao(
    payload.correlationId || job.correlation_id,
    payload.numeroVenda || job.numero_venda,
    "INCERTO",
    null,
    motivo || `Aguardando retry de consulta (${tentativasConsulta}/${MAX_TENTATIVAS_CONSULTA})`,
  );
  log.info(
    {
      jobId: job.id,
      tentativasConsulta,
      proximoRetryAt: proximo,
    },
    "Recovery consulta agendada com backoff",
  );
  return { acao: "AGENDADO", proximoRetryAt: proximo, tentativasConsulta };
}

async function recuperarJob(job, lerConfigFn, opts = {}) {
  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return { acao: "FALHA", motivo: "payload inválido" };
  }

  const correlationId = payload.correlationId || job.correlation_id;
  filaFiscal.salvarResultadoEmissao(
    correlationId,
    payload.numeroVenda || job.numero_venda,
    "RECUPERANDO",
    null,
    "Consulta SEFAZ antes de reprocessar",
  );
  filaFiscal.marcarJob(job.id, "RECUPERANDO");

  let existente = null;
  try {
    existente = await verificarAntesDeEmitir(payload);
  } catch (err) {
    if (err.acbrOffline || !acbrDisponivelMemoria()) {
      return { acao: "ACBR_OFFLINE" };
    }
    throw err;
  }

  if (existente?.fiscal !== false && existente?.chave) {
    const cfg = await lerConfigFn();
    const fiscalService = require("./fiscalService");
    const final = await fiscalService.finalizarEmissaoRecuperada(
      cfg,
      payload.numeroVenda,
      correlationId,
      existente,
    );
    filaFiscal.salvarResultadoEmissao(
      correlationId,
      payload.numeroVenda,
      "CONCLUIDO_RECUPERADO",
      final,
      null,
    );
    filaFiscal.marcarJob(job.id, "CONCLUIDO");
    return { acao: "RECUPERADO", chave: existente.chave };
  }

  if (!acbrDisponivelMemoria()) {
    return { acao: "ACBR_OFFLINE" };
  }

  if (opts.somenteConsulta) {
    return { acao: "NAO_ENCONTRADO" };
  }

  filaFiscal.marcarJob(job.id, "PENDENTE");
  filaFiscal.salvarResultadoEmissao(
    correlationId,
    payload.numeroVenda || job.numero_venda,
    "PENDENTE",
    null,
    "Aguardando reprocessamento após consulta sem autorização",
  );
  return { acao: "REAGENDADO" };
}

async function tentarRecuperacaoConsulta(job, lerConfigFn) {
  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return { acao: "FALHA", motivo: "payload inválido" };
  }

  const existenteLocal = await verificarAntesDeEmitir(payload);
  if (existenteLocal?.fiscal !== false && existenteLocal?.chave) {
    const cfg = await lerConfigFn();
    const fiscalService = require("./fiscalService");
    const correlationId = payload.correlationId || job.correlation_id;
    const final = await fiscalService.finalizarEmissaoRecuperada(
      cfg,
      payload.numeroVenda,
      correlationId,
      existenteLocal,
    );
    filaFiscal.salvarResultadoEmissao(
      correlationId,
      payload.numeroVenda,
      "CONCLUIDO_RECUPERADO",
      final,
      null,
    );
    filaFiscal.marcarJob(job.id, "CONCLUIDO");
    filaFiscal.agendarRetryConsulta(job.id, 0, new Date().toISOString());
    return { acao: "RECUPERADO", chave: existenteLocal.chave };
  }

  const tentativas = (job.tentativas_consulta || 0) + 1;

  if (tentativas > MAX_TENTATIVAS_CONSULTA) {
    const falha = filaFiscal.marcarFalhaConsultaTimeout(job, "ACBr_OFFLINE_TIMEOUT");
    auditLog.registrar("RECOVERY_CONSULTA_TIMEOUT", {
      jobId: job.id,
      correlationId: falha.correlationId,
      numeroVenda: falha.numeroVenda,
      tentativasConsulta: job.tentativas_consulta,
    });
    return { acao: "TIMEOUT", motivo: "ACBr_OFFLINE_TIMEOUT" };
  }

  if (!acbrDisponivelMemoria()) {
    return agendarBackoff(job, tentativas, "ACBr offline — consulta adiada");
  }

  const r = await recuperarJob(job, lerConfigFn, { somenteConsulta: true });

  if (r.acao === "RECUPERADO") {
    filaFiscal.agendarRetryConsulta(job.id, 0, new Date().toISOString());
    return r;
  }

  if (r.acao === "ACBR_OFFLINE") {
    return agendarBackoff(job, tentativas, "ACBr offline — consulta adiada");
  }

  if (r.acao === "NAO_ENCONTRADO") {
    return recuperarJob(job, lerConfigFn, { somenteConsulta: false });
  }

  return r;
}

async function processarFilaRecovery(lerConfigFn) {
  if (typeof lerConfigFn !== "function") return { processados: 0 };
  const jobs = filaFiscal.listarJobsRecoveryProntos(5);
  let processados = 0;
  for (const job of jobs) {
    try {
      await tentarRecuperacaoConsulta(job, lerConfigFn);
      processados++;
    } catch (err) {
      log.warn({ jobId: job.id, err: err.message }, "Falha no recovery consulta");
    }
  }
  return { processados };
}

async function forcarRecoveryManual(lerConfigFn) {
  const resetados = filaFiscal.resetProximoRetryRecovery();
  const jobs = filaFiscal.listarJobsRecoveryProntos(100);
  let jobsReprocessados = 0;
  for (const job of jobs) {
    try {
      await tentarRecuperacaoConsulta(job, lerConfigFn);
      jobsReprocessados++;
    } catch (err) {
      log.warn({ jobId: job.id, err: err.message }, "Recovery manual falhou");
    }
  }
  return {
    jobsReprocessados,
    resetados,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  consultarDocumentoAutorizado,
  verificarAntesDeEmitir,
  recuperarJob,
  tentarRecuperacaoConsulta,
  processarFilaRecovery,
  forcarRecoveryManual,
  calcularDelayMs,
  MAX_TENTATIVAS_CONSULTA,
};
