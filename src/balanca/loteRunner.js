"use strict";

const path = require("path");
const fs = require("fs");
const { exigirPermitido } = require("./allowlist");
const { limparTemporariosOrfaos } = require("./pasta");
const { validarSha256, escreverAtomico, ordenarArquivos } = require("./atomicWrite");
const { auditDir } = require("./config");
const { processarLoteWs } = require("./wsRunner");
const {
  entregarPastaMonitorada,
  entregarGatilhoPorData,
  entregarManual,
} = require("./entrega");
const { aplicarRetencaoSnapshots } = require("./retencao");
const {
  tipoEscritaDeNome,
  resolverModoSombra,
  STATUS_UI,
} = require("./tipoEscrita");
const log = require("../../logger").child({ modulo: "balanca_lote" });

const INCREMENTAL_STATE_FILE = ".me-balanca-incremental-state.json";

/**
 * Processa um lote do backend.
 * Prioridade modoSombra: lote (claim) > config local.
 */
async function processarLote(lote, cfg, hooks = {}) {
  const modoEntrega = String(lote.modoEntrega || cfg.modoEntrega || "PASTA").toUpperCase();
  const modoSombra = resolverModoSombra(lote, cfg);
  const cfgEfetivo = { ...cfg, modoSombra };

  if (modoEntrega === "WS_MGV7") {
    return processarLoteWs(lote, cfgEfetivo);
  }

  const arquivos = Array.isArray(lote.arquivos) ? lote.arquivos : [];
  for (const a of arquivos) {
    exigirPermitido(a.nome);
    validarSha256(a.conteudoBase64, a.sha256);
    if (!a.tipoEscrita) {
      a.tipoEscrita = tipoEscritaDeNome(a.nome);
    }
  }

  if (modoSombra) {
    return processarSombra(lote, cfgEfetivo, arquivos);
  }

  // Gate incremental: não sobrescreve PRECOMGV/EXCLITEM sem confirmação/timeout
  const gate = avaliarGateIncremental(lote, cfgEfetivo, arquivos);
  if (!gate.ok) {
    log.warn({ detalhe: gate.detalhe, loteId: lote.loteId }, "Incremental bloqueado");
    return {
      status: "ERRO",
      detalhe: gate.detalhe,
      evidenciasBak: [],
      statusUi: STATUS_UI.AGUARDANDO_CONFIRMACAO,
    };
  }
  if (gate.aviso) {
    log.warn({ aviso: gate.aviso, loteId: lote.loteId }, "Incremental com timeout — enviando mesmo assim");
  }

  try {
    let resultado;
    if (modoEntrega === "MANUAL") {
      resultado = await entregarManual(lote, cfgEfetivo, arquivos);
    } else if (modoEntrega === "PASTA_GATILHO_POR_DATA") {
      resultado = await entregarGatilhoPorData(lote, cfgEfetivo, arquivos, hooks);
    } else {
      resultado = await entregarPastaMonitorada(lote, cfgEfetivo, arquivos, hooks);
    }
    if (temIncremental(arquivos) && (resultado.status === "ENTREGUE" || resultado.status === "IMPORTADO"
        || resultado.status === "ENTREGUE_SEM_CONFIRMACAO")) {
      marcarIncrementalEnviado(cfgEfetivo, lote, arquivos, resultado.status);
    }
    if (resultado.status === "IMPORTADO") {
      limparIncrementalPendente(cfgEfetivo);
    }
    return resultado;
  } catch (err) {
    log.warn({ err: err.message }, "Falha na entrega de balança");
    return { status: "ERRO", detalhe: err.message, evidenciasBak: [] };
  }
}

function temIncremental(arquivos) {
  return arquivos.some((a) => (a.tipoEscrita || tipoEscritaDeNome(a.nome)) === "INCREMENTAL");
}

function statePath(cfg) {
  const pasta = String(cfg.pastaCarga || "").trim() || process.cwd();
  return path.join(pasta, INCREMENTAL_STATE_FILE);
}

function lerEstadoIncremental(cfg) {
  try {
    const p = statePath(cfg);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function marcarIncrementalEnviado(cfg, lote, arquivos, status) {
  const nomes = arquivos
    .filter((a) => (a.tipoEscrita || tipoEscritaDeNome(a.nome)) === "INCREMENTAL")
    .map((a) => a.nome);
  if (!nomes.length) return;
  const estado = {
    loteId: lote.loteId,
    nomes,
    enviadoEm: new Date().toISOString(),
    confirmado: status === "IMPORTADO",
    avisoTimeout: false,
  };
  try {
    fs.writeFileSync(statePath(cfg), JSON.stringify(estado, null, 2), "utf8");
  } catch (err) {
    log.warn({ err: err.message }, "Falha ao gravar estado incremental");
  }
}

function limparIncrementalPendente(cfg) {
  try {
    const p = statePath(cfg);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * Se há incremental no lote e ainda há incremental anterior não confirmado
 * dentro do timeout → bloqueia. Após timeout → permite com aviso.
 */
function avaliarGateIncremental(lote, cfg, arquivos) {
  if (!temIncremental(arquivos)) return { ok: true };
  // Snapshot-only profile: backend não deveria enviar incremental, mas se mandar e
  // usaIncremental=false no claim, bloqueia.
  if (lote.usaIncremental === false) {
    return {
      ok: false,
      detalhe: "Gerenciador com usaIncremental=false — lote incremental rejeitado. Use carga FULL (ITENSMGV).",
    };
  }
  const prev = lerEstadoIncremental(cfg);
  if (!prev || prev.confirmado) return { ok: true };
  const timeoutMin = Number(lote.incrementalTimeoutMin || cfg.incrementalTimeoutMin || 120);
  const enviadoEm = prev.enviadoEm ? Date.parse(prev.enviadoEm) : 0;
  const idadeMin = enviadoEm ? (Date.now() - enviadoEm) / 60000 : timeoutMin + 1;
  if (idadeMin < timeoutMin) {
    const resta = Math.ceil(timeoutMin - idadeMin);
    return {
      ok: false,
      detalhe:
        `Incremental anterior (${(prev.nomes || []).join(", ")}) ainda aguarda confirmação ` +
        `(há ${Math.floor(idadeMin)} min). Aguarde .BAK/confirmação ou ${resta} min de timeout.`,
    };
  }
  return {
    ok: true,
    aviso:
      `Incremental anterior não confirmado há ${Math.floor(idadeMin)} min ` +
      `(timeout ${timeoutMin} min) — enviando mesmo assim.`,
  };
}

async function processarSombra(lote, cfg, arquivos) {
  const pastaAudit = auditDir(cfg.pastaCarga);
  fs.mkdirSync(pastaAudit, { recursive: true });
  limparTemporariosOrfaos(pastaAudit);
  const loteDir = path.join(pastaAudit, String(lote.loteId || Date.now()));
  fs.mkdirSync(loteDir, { recursive: true });
  const nomes = [];
  try {
    for (const a of ordenarArquivos(arquivos)) {
      const buf = validarSha256(a.conteudoBase64, a.sha256);
      escreverAtomico(loteDir, a.nome, buf, cfg.encoding);
      nomes.push(a.nome);
    }
    fs.writeFileSync(
      path.join(loteDir, "_meta.json"),
      JSON.stringify({
        loteId: lote.loteId,
        em: new Date().toISOString(),
        arquivos: nomes,
        modo: "SOMBRA",
      }, null, 2),
      "utf8",
    );
    aplicarRetencaoSnapshots(pastaAudit, cfg.retencaoSnapshots || 5);
  } catch (err) {
    return { status: "ERRO", detalhe: `SOMBRA falhou: ${err.message}`, evidenciasBak: [] };
  }
  return {
    status: "ENTREGUE",
    detalhe: `SOMBRA: arquivos gravados em ${loteDir} (pasta MGV não foi tocada)`,
    evidenciasBak: [],
    statusUi: STATUS_UI.AGUARDANDO_CONFIRMACAO,
  };
}

module.exports = {
  processarLote,
  avaliarGateIncremental,
  limparIncrementalPendente,
  marcarIncrementalEnviado,
};
