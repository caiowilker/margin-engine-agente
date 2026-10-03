"use strict";

const fs = require("fs");
const path = require("path");
const {
  ler,
  salvar,
  configPath,
  auditDir,
  efetivar,
  pastaCargaDefault,
  DEFAULTS,
} = require("./config");
const { diagnosticarPasta, listarPresentes, limparTemporariosOrfaos } = require("./pasta");
const worker = require("./worker");
const { version: AGENT_VERSION } = require("../../package.json");

function getDiagnostico() {
  const cfg = efetivar(ler());
  const pasta = cfg.modoSombra ? auditDir(cfg.pastaCargaConfigurada) : cfg.pastaCarga;
  let diag = { ok: false, erro: "Pasta de carga não resolvível." };
  try {
    if (pasta) {
      fs.mkdirSync(pasta, { recursive: true });
      diag = diagnosticarPasta(pasta);
      if (cfg.modoSombra && cfg.pastaCarga) {
        const mgv = diagnosticarPasta(cfg.pastaCarga);
        diag.mgv = mgv;
      }
    }
  } catch (err) {
    diag = {
      ok: false,
      erro: err.message || "Falha ao acessar pasta de carga.",
      codigo: "BALANCA_PASTA_INACESSIVEL",
    };
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
      pastaCarga: cfg.pastaCargaConfigurada || "",
      pastaCargaEfetiva: cfg.pastaCarga,
      pastaCargaDefault: pastaCargaDefault(),
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
      const cfg = efetivar(ler());
      const n1 = limparTemporariosOrfaos(cfg.pastaCarga);
      const n2 = limparTemporariosOrfaos(auditDir(cfg.pastaCargaConfigurada));
      res.json({ removidos: n1 + n2 });
    },
  );

  /**
   * Testa escrita em pasta arbitrária sem alterar a config de produção.
   * Body: { pasta: string }
   */
  app.post(
    "/balanca/testar-pasta",
    privateNetworkHeaders,
    exigirAgentToken,
    (req, res) => {
      const pasta = String(req.body?.pasta || "").trim();
      if (!pasta) {
        return res.status(400).json({
          ok: false,
          erro: "pasta é obrigatória",
          codigo: "BALANCA_PASTA_VAZIA",
        });
      }
      try {
        const diag = diagnosticarPasta(pasta);
        return res.json({ ok: !!diag.ok && !diag.ocupada, pasta, ...diag });
      } catch (err) {
        return res.status(500).json({
          ok: false,
          pasta,
          erro: err.message,
          codigo: "BALANCA_ERRO_PASTA",
        });
      }
    },
  );
}

function boot(opts = {}) {
  worker.configurar(opts);
  try {
    const cfg = efetivar(ler());
    if (cfg.pastaCarga) limparTemporariosOrfaos(cfg.pastaCarga);
    limparTemporariosOrfaos(auditDir(cfg.pastaCargaConfigurada));
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
