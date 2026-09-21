"use strict";

const fs = require("fs");
const path = require("path");
const { exigirPermitido } = require("./allowlist");
const { diagnosticarPasta, limparTemporariosOrfaos } = require("./pasta");
const {
  validarSha256,
  escreverAtomico,
  ordenarArquivos,
} = require("./atomicWrite");
const { aguardarBak } = require("./bakPoll");
const { auditDir } = require("./config");
const { processarLoteWs } = require("./wsRunner");
const { aplicarRetencaoSnapshots } = require("./retencao");
const log = require("../../logger").child({ modulo: "balanca_entrega" });

/**
 * Estratégias de entrega Etapa 9.
 * @returns {Promise<{ status: string, detalhe?: string, evidenciasBak?: string[] }>}
 */
async function entregarPastaMonitorada(lote, cfg, arquivos, hooks = {}) {
  const pasta = String(cfg.pastaCarga || "").trim();
  limparTemporariosOrfaos(pasta);
  const diag = diagnosticarPasta(pasta);
  if (diag.ocupada) {
    return { status: "PASTA_OCUPADA", detalhe: diag.erro, evidenciasBak: [] };
  }
  if (!diag.ok) {
    return { status: "PASTA_INACESSIVEL", detalhe: diag.erro || "Pasta inacessível", evidenciasBak: [] };
  }

  const escritos = [];
  for (const a of ordenarArquivos(arquivos)) {
    const buf = validarSha256(a.conteudoBase64, a.sha256);
    const r = escreverAtomico(pasta, a.nome, buf, cfg.encoding);
    escritos.push(r.nome);
  }
  if (typeof hooks.onEscrito === "function") {
    await hooks.onEscrito(escritos);
  }

  const evidencia = String(lote.evidenciaEstrategia || cfg.evidenciaEstrategia || "ARQUIVO_RENOMEADO_BAK").toUpperCase();
  if (evidencia === "NENHUMA") {
    return {
      status: "ENTREGUE_SEM_CONFIRMACAO",
      detalhe: "Arquivos gravados; sem evidência automática — reconcilie manualmente na balança.",
      evidenciasBak: [],
    };
  }

  if (evidencia === "ARQUIVO_CONSUMIDO") {
    const timeoutMs = (lote.timeoutImportacaoSeg || cfg.timeoutImportacaoSeg || 120) * 1000;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const pendentes = escritos.filter((n) => fs.existsSync(path.join(pasta, n)));
      if (pendentes.length === 0) {
        return {
          status: "IMPORTADO",
          detalhe: "Arquivos consumidos/removidos da pasta",
          evidenciasBak: escritos.map((n) => n + " (removido)"),
        };
      }
      await new Promise((r) => setTimeout(r, cfg.intervaloPollingBakMs || 1000));
    }
    return {
      status: "TIMEOUT_IMPORTACAO",
      detalhe: "Arquivos ainda na pasta após timeout (estratégia CONSUMIDO)",
      evidenciasBak: [],
    };
  }

  // default BAK
  const timeoutMs = (lote.timeoutImportacaoSeg || cfg.timeoutImportacaoSeg || 120) * 1000;
  const poll = await aguardarBak(pasta, escritos, {
    timeoutMs,
    intervalMs: cfg.intervaloPollingBakMs || 1000,
  });
  if (poll.ok) {
    return {
      status: "IMPORTADO",
      detalhe: `Importação confirmada em ${poll.elapsedMs}ms`,
      evidenciasBak: poll.evidencias.map((e) => path.basename(e.bak)),
    };
  }
  return {
    status: "TIMEOUT_IMPORTACAO",
    detalhe: `${poll.mensagem} Pendentes: ${(poll.pendentes || []).join(", ")}. Causa: ${poll.causaProvavel}`,
    evidenciasBak: (poll.evidencias || []).map((e) => path.basename(e.bak)),
  };
}

async function entregarGatilhoPorData(lote, cfg, arquivos, hooks = {}) {
  const base = await entregarPastaMonitorada(
    { ...lote, evidenciaEstrategia: "NENHUMA" },
    cfg,
    arquivos,
    hooks,
  );
  if (base.status !== "ENTREGUE_SEM_CONFIRMACAO" && base.status !== "IMPORTADO" && base.status !== "ENTREGUE") {
    return base;
  }
  const gatilho = String(lote.arquivoGatilhoConfig || cfg.arquivoGatilhoConfig || "").trim();
  if (!gatilho) {
    return {
      status: "ENTREGUE_SEM_CONFIRMACAO",
      detalhe: "Gatilho por data: arquivo de config não informado ([RELATO] Integra). Dados gravados.",
      evidenciasBak: [],
    };
  }
  const pasta = String(cfg.pastaCarga || "").trim();
  if (!pasta) {
    return {
      status: "ERRO",
      detalhe: "Gatilho por data exige pastaCarga configurada.",
      evidenciasBak: [],
    };
  }
  // Segurança: gatilho só dentro da pasta de carga (bloqueia path traversal / absoluto fora).
  const pastaAbs = path.resolve(pasta);
  const alvo = path.resolve(pastaAbs, gatilho);
  const rel = path.relative(pastaAbs, alvo);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      status: "ERRO",
      detalhe: "Arquivo gatilho fora da pasta de carga — path rejeitado.",
      evidenciasBak: [],
    };
  }
  try {
    const now = new Date();
    fs.utimesSync(alvo, now, now);
    return {
      status: "ENTREGUE_SEM_CONFIRMACAO",
      detalhe: `Dados gravados e mtime tocado em ${path.basename(alvo)} ([RELATO] Integra). Reconcilie na balança.`,
      evidenciasBak: [],
    };
  } catch (err) {
    return {
      status: "ERRO",
      detalhe: `Falha ao tocar arquivo gatilho: ${err.message}`,
      evidenciasBak: [],
    };
  }
}

async function entregarManual(lote, cfg, arquivos) {
  // MANUAL: não grava na pasta MGV — só auditoria/sombra local para download na UI
  const pastaAudit = auditDir(cfg.pastaCarga || process.cwd());
  fs.mkdirSync(pastaAudit, { recursive: true });
  const loteDir = path.join(pastaAudit, String(lote.loteId || Date.now()));
  fs.mkdirSync(loteDir, { recursive: true });
  for (const a of ordenarArquivos(arquivos)) {
    exigirPermitido(a.nome);
    const buf = validarSha256(a.conteudoBase64, a.sha256);
    escreverAtomico(loteDir, a.nome, buf, cfg.encoding);
  }
  fs.writeFileSync(
    path.join(loteDir, "_manual.json"),
    JSON.stringify({
      loteId: lote.loteId,
      modo: "MANUAL",
      instrucao: "Importe o TXT no software da balança conforme o assistente (passo a passo).",
    }, null, 2),
    "utf8",
  );
  aplicarRetencaoSnapshots(pastaAudit, cfg.retencaoSnapshots || 5);
  return {
    status: "ENTREGUE_SEM_CONFIRMACAO",
    detalhe: `MANUAL: arquivos em ${loteDir} — importe no software e reconcilie.`,
    evidenciasBak: [],
  };
}

module.exports = {
  entregarPastaMonitorada,
  entregarGatilhoPorData,
  entregarManual,
};
