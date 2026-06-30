// Re-emissão segura — consulta SEFAZ/chave/nNF antes de reenviar
const fiscalDriver = require("./fiscalDriver");
const docs = require("./documentosFiscais");
const { coalescerRespostaAcbr } = require("./fiscalDriverResposta");
const filaFiscal = require("./filaFiscal");
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "fiscal_recuperacao" });

const MAX_TENTATIVAS_CONSULTA = parseInt(
  process.env.MAX_TENTATIVAS_CONSULTA || "12",
  10,
);
const BACKOFF_BASE_MS = 120000;
const BACKOFF_CAP_MS = 1800000;
const BACKOFF_104_MS = parseInt(process.env.FISCAL_RECOVERY_104_MS || "45000", 10);

function calcularDelayMs(tentativasAposFalha, opts = {}) {
  if (opts.lote104) {
    return Math.min(BACKOFF_104_MS * Math.max(1, tentativasAposFalha), BACKOFF_CAP_MS);
  }
  const n = Math.max(1, tentativasAposFalha);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

function calcularProximoRetryIso(tentativasConsulta, opts = {}) {
  const delay = calcularDelayMs(tentativasConsulta, opts);
  return new Date(Date.now() + delay).toISOString();
}

function jobIncertoPorLote104(job, payload = {}) {
  const err = String(job?.erro || "");
  if (/cStat\s*104|lote processado|aguardando confirma/i.test(err)) return true;
  return /104|lote processado/i.test(
    String(payload.motivoIncerto || payload._fiscalMeta?.cStat || ""),
  );
}

function fiscalDriverDisponivelMemoria() {
  if (!fiscalDriver.EMISSAO_FISCAL) return false;
  return fiscalDriver.obterStatusMemoria(false) !== "offline";
}

async function consultarDocumentoAutorizado(meta = {}) {
  let { chave, serie, numeroNfe, numeroVenda, cnpj } = meta;

  if (!chave && numeroVenda) {
    const doc = filaFiscal.buscarDocumentoPorVenda(numeroVenda);
    if (doc?.chave) chave = doc.chave;
  }
  if (!chave && serie && numeroNfe) {
    const doc = filaFiscal.buscarDocumentoPorSerieNumero(serie, numeroNfe);
    if (doc?.chave) chave = doc.chave;
  }
  if (!chave && (serie && numeroNfe || numeroVenda)) {
    const localSerie = docs.localizarXmlPorSerieNumero(
      serie,
      numeroNfe,
      cnpj || (chave ? docs.extrairCnpjDaChave(chave) : null),
    );
    if (localSerie?.chave) chave = localSerie.chave;
    else if (localSerie?.xml) chave = docs.extrairChaveDoXml(localSerie.xml);
  }

  if (numeroVenda) {
    const local = filaFiscal.buscarDocumentoPorVenda(numeroVenda);
    if (local?.chave && local.c_stat && ["100", "150"].includes(String(local.c_stat))) {
      return montarDeDocumentoLocal(local);
    }
  }

  if (chave) {
    const localXml = docs.localizarXmlPorChave(chave);
    if (localXml?.xml) {
      const prot = localXml.prot || docs.extrairProtNFe(localXml.xml);
      if (prot.cStat === "100" || prot.cStat === "150") {
        return {
          fiscal: true,
          chave,
          numero: meta.numeroNfe,
          serie: meta.serieNfe || "001",
          protocolo: prot.nProt,
          cStat: prot.cStat || "100",
          xMotivo: prot.xMotivo,
          xml: localXml.xml,
          xmlPath: localXml.path,
          modeloDocumento: fiscalDriver.inferirModeloDaChave(chave) || "65",
          recuperado: true,
        };
      }
    }
  }

  if (chave && fiscalDriverDisponivelMemoria()) {
    try {
      const consulta = await fiscalDriver.consultarChave(chave);
      const cs = String(consulta.cStat || "");
      if (
        consulta.situacao === "AUTORIZADA" ||
        cs === "100" ||
        cs === "150"
      ) {
        const rawTxt = coalescerRespostaAcbr(consulta.raw);
        const localXml = docs.localizarXmlPorChave(chave);
        const xmlAutorizado =
          localXml?.xml && docs.xmlEstaAutorizado(localXml.xml)
            ? localXml.xml
            : null;
        return {
          fiscal: true,
          chave,
          numero: rawTxt.match(/Numero=(\d+)/)?.[1] || meta.numeroNfe,
          serie: rawTxt.match(/Serie=(\d+)/)?.[1] || meta.serieNfe || "001",
          protocolo: consulta.protocolo,
          cStat: consulta.cStat || "100",
          xMotivo: consulta.xMotivo,
          xml: xmlAutorizado,
          xmlPath: localXml?.path || null,
          modeloDocumento: fiscalDriver.inferirModeloDaChave(chave) || "65",
          recuperado: true,
        };
      }
    } catch (err) {
      log.warn({ chave, err: err.message }, "Consulta chave falhou");
      if (!fiscalDriverDisponivelMemoria()) {
        const e = new Error("ACBr offline");
        e.fiscalDriverOffline = true;
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
  const chave = doc.chave;
  return {
    fiscal: true,
    chave,
    numero: doc.numero_nfe || null,
    serie: doc.serie_nfe || "001",
    protocolo: doc.protocolo,
    cStat: doc.c_stat || "100",
    xml,
    xmlPath: doc.xml_path || null,
    modeloDocumento:
      doc.modelo_documento || fiscalDriver.inferirModeloDaChave(chave) || "65",
    recuperado: true,
  };
}

async function verificarAntesDeEmitir(payload) {
  const meta = {
    chave:
      payload.chave ||
      payload.chaveConsulta ||
      payload._fiscalMeta?.chave ||
      null,
    serie: payload.serieNfe || payload._fiscalMeta?.serieNfe,
    numeroNfe: payload.numeroNfe || payload._fiscalMeta?.numeroNfe,
    numeroVenda: payload.numeroVenda,
    cnpj:
      payload.empresa?.cnpj ||
      payload.cnpj ||
      payload.emitente?.cnpj ||
      null,
  };
  return consultarDocumentoAutorizado(meta);
}

function agendarBackoff(job, tentativasConsulta, motivo, opts = {}) {
  const proximo = calcularProximoRetryIso(tentativasConsulta, opts);
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
    if (err.fiscalDriverOffline || !fiscalDriverDisponivelMemoria()) {
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

  if (!fiscalDriverDisponivelMemoria()) {
    return { acao: "ACBR_OFFLINE" };
  }

  if (opts.somenteConsulta) {
    return { acao: "NAO_ENCONTRADO" };
  }

  if (opts.permitirReemissao !== true) {
    return agendarBackoff(
      job,
      job.tentativas_consulta || 1,
      "Consulta sem autorização — reemissão bloqueada (use forcarEmissao no painel)",
    );
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
  try {
    return await tentarRecuperacaoConsultaInterno(job, lerConfigFn);
  } catch (err) {
    log.warn({ jobId: job.id, err: err.message }, "Recovery consulta — erro inesperado");
    const tentativas = (job.tentativas_consulta || 0) + 1;
    if (tentativas > MAX_TENTATIVAS_CONSULTA) {
      return { acao: "TIMEOUT", motivo: err.message };
    }
    let payload = {};
    try {
      payload = JSON.parse(job.payload);
    } catch (_) {}
    const backoffOpts = jobIncertoPorLote104(job, payload) ? { lote104: true } : {};
    return agendarBackoff(
      job,
      tentativas,
      `Erro na consulta: ${err.message}`,
      backoffOpts,
    );
  }
}

async function tentarRecuperacaoConsultaInterno(job, lerConfigFn) {
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

  if (!fiscalDriverDisponivelMemoria()) {
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
    const chave =
      payload.chaveConsulta ||
      payload.chave ||
      payload._fiscalMeta?.chave ||
      null;
    const msg = chave
      ? `Lote processado (104) — aguardando protocolo SEFAZ (chave ${String(chave).slice(0, 12)}…)`
      : "Nota ainda não localizada na consulta — aguardando indexação SEFAZ";
    const backoffOpts = jobIncertoPorLote104(job, payload) ? { lote104: true } : {};
    return agendarBackoff(job, tentativas, msg, backoffOpts);
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
