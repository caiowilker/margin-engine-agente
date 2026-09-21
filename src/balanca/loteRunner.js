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
const log = require("../../logger").child({ modulo: "balanca_lote" });

/**
 * Processa um lote do backend.
 * @param {object} [hooks]
 * @param {(nomes: string[]) => Promise<void>} [hooks.onEscrito]
 */
async function processarLote(lote, cfg, hooks = {}) {
  const modoEntrega = String(lote.modoEntrega || cfg.modoEntrega || "PASTA").toUpperCase();
  if (modoEntrega === "WS_MGV7") {
    return processarLoteWs(lote, cfg);
  }

  const arquivos = Array.isArray(lote.arquivos) ? lote.arquivos : [];
  for (const a of arquivos) {
    exigirPermitido(a.nome);
    validarSha256(a.conteudoBase64, a.sha256);
  }

  if (cfg.modoSombra) {
    return processarSombra(lote, cfg, arquivos);
  }

  try {
    if (modoEntrega === "MANUAL") {
      return await entregarManual(lote, cfg, arquivos);
    }
    if (modoEntrega === "PASTA_GATILHO_POR_DATA") {
      return await entregarGatilhoPorData(lote, cfg, arquivos, hooks);
    }
    // PASTA / PASTA_MONITORADA
    return await entregarPastaMonitorada(lote, cfg, arquivos, hooks);
  } catch (err) {
    log.warn({ err: err.message }, "Falha na entrega de balança");
    return { status: "ERRO", detalhe: err.message, evidenciasBak: [] };
  }
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
  };
}

module.exports = { processarLote };
