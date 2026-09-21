"use strict";

const fs = require("fs");
const path = require("path");
const { ler, salvar, configPath, auditDir, DEFAULTS } = require("./config");
const { diagnosticarPasta, listarPresentes, limparTemporariosOrfaos } = require("./pasta");
const worker = require("./worker");
const { version: AGENT_VERSION } = require("../../package.json");

function getDiagnostico() {
  const cfg = ler();
  const pasta = cfg.modoSombra ? auditDir(cfg.pastaCarga) : cfg.pastaCarga;
  let diag = { ok: false, erro: "sem pasta" };
  try {
    if (pasta) {
      if (cfg.modoSombra) {
        fs.mkdirSync(pasta, { recursive: true });
      }
      diag = diagnosticarPasta(pasta);
      // em sombra, ocupação da pasta MGV não bloqueia — reavaliar pasta real se existir
      if (cfg.modoSombra && cfg.pastaCarga) {
        const mgv = diagnosticarPasta(cfg.pastaCarga);
        diag.mgv = mgv;
      }
    }
  } catch (err) {
    diag = { ok: false, erro: err.message };
  }
  const h = worker.health();
  return {
    ok: true,
    modulo: "balanca",
    versaoModulo: "1.0.0",
    agentVersion: AGENT_VERSION,
    configPath: configPath(),
    config: {
      enabled: cfg.enabled,
      gerenciadorId: cfg.gerenciadorId,
      pastaCarga: cfg.pastaCarga,
      encoding: cfg.encoding,
      timeoutImportacaoSeg: cfg.timeoutImportacaoSeg,
      intervaloPollingBakMs: cfg.intervaloPollingBakMs,
      modoSombra: cfg.modoSombra,
      pollBackendMs: cfg.pollBackendMs,
      modoEntrega: cfg.modoEntrega,
      wsBaseUrl: cfg.wsBaseUrl,
      wsLojaCodigo: cfg.wsLojaCodigo,
    },
    pasta: diag,
    ws: null,
    arquivosPresentes: cfg.pastaCarga ? listarPresentes(cfg.pastaCarga) : [],
    ultimoLote: h.ultimoLote,
    ultimoErro: h.ultimoErro,
    workerAtivo: h.workerAtivo,
    defaults: DEFAULTS,
  };
}

async function getDiagnosticoAsync() {
  const base = getDiagnostico();
  if (String(base.config?.modoEntrega || "").toUpperCase() === "WS_MGV7") {
    try {
      const { diagnosticoWs } = require("./wsRunner");
      base.ws = await diagnosticoWs(ler());
    } catch (err) {
      base.ws = { erro: err.message };
    }
  }
  return base;
}

function registerRoutes(app, { privateNetworkHeaders, exigirAgentToken }) {
  app.get(
    "/balanca/diagnostico",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      try {
        getDiagnosticoAsync()
          .then((d) => res.json(d))
          .catch((err) => {
            res.status(500).json({
              ok: false,
              erro: err.message,
              causaProvavel: "Falha ao montar diagnóstico do módulo de balança.",
            });
          });
      } catch (err) {
        res.status(500).json({
          ok: false,
          erro: err.message,
          causaProvavel: "Falha ao montar diagnóstico do módulo de balança.",
        });
      }
    },
  );

  app.put(
    "/balanca/secrets",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      try {
        const balancaSecrets = require("./balancaSecrets");
        const body = req.body || {};
        balancaSecrets.salvarSync({
          usuario: body.usuario,
          senha: body.senha,
          palavraChave: body.palavraChave,
        });
        res.json({ ok: true, ...balancaSecrets.resumoSeguro() });
      } catch (err) {
        res.status(400).json({ erro: err.message });
      }
    },
  );

  app.get(
    "/balanca/secrets/status",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      const balancaSecrets = require("./balancaSecrets");
      res.json(balancaSecrets.resumoSeguro());
    },
  );

  app.get(
    "/balanca/config",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      res.json(ler());
    },
  );

  app.put(
    "/balanca/config",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      try {
        const saved = salvar(req.body || {});
        // reinicia worker com novo intervalo
        worker.iniciarWorker();
        res.json(saved);
      } catch (err) {
        res.status(400).json({
          erro: err.message,
          causaProvavel: "Schema de balanca-carga.json inválido.",
        });
      }
    },
  );

  app.post(
    "/balanca/limpar-tmp",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      const cfg = ler();
      const n1 = limparTemporariosOrfaos(cfg.pastaCarga);
      const n2 = limparTemporariosOrfaos(auditDir(cfg.pastaCarga));
      res.json({ removidos: n1 + n2 });
    },
  );
}

function boot(opts = {}) {
  worker.configurar(opts);
  try {
    const cfg = ler();
    if (cfg.pastaCarga) limparTemporariosOrfaos(cfg.pastaCarga);
    limparTemporariosOrfaos(auditDir(cfg.pastaCarga));
  } catch {
    /* ignore */
  }
  worker.iniciarWorker();
}

module.exports = {
  boot,
  registerRoutes,
  getDiagnostico,
  getDiagnosticoAsync,
  health: () => worker.health(),
  lerConfig: ler,
  salvarConfig: salvar,
  worker,
};
