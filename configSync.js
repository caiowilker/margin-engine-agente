// Sincronização periódica de config do terminal com o backend (Parte D + F)
const log = require("./logger").child({ modulo: "config_sync" });
const runtimeConfig = require("./runtimeConfig");
const catalog = require("./agentConfigCatalog");
const fiscalConfigAuthority = require("./fiscalConfigAuthority");

let pollIntervalMs = parseInt(
  process.env.CONFIG_POLL_INTERVAL_MS || "45000",
  10,
);

let estado = {
  fiscalEnabled: null,
  somErroProdutoNaoEncontrado: null,
  avisoObrigatorioProdutoNaoCadastrado: null,
  operacional: null,
  fonte: "env",
  ultimaSincronizacaoOk: null,
  ultimaTentativaEm: null,
  ultimoErro: null,
  configAtualizadaEm: null,
  agenteSincronizadoEm: null,
};

let intervalHandle = null;
let acbrRef = null;
let lerConfigFnRef = null;
let sincronizando = false;

function obterEnvFallbackFiscal() {
  return (process.env.EMISSAO_FISCAL || "false").toLowerCase() === "true";
}

function getStatus() {
  const fiscalAtivo =
    estado.fiscalEnabled !== null ? estado.fiscalEnabled : obterEnvFallbackFiscal();
  const authority = fiscalConfigAuthority.obterStatus();
  return {
    fiscalEnabled: fiscalAtivo,
    operacional: estado.operacional || runtimeConfig.getOperacional(),
    fonte: authority.ativo ? "agente_local" : estado.fonte,
    autoridadeLocal: authority,
    ultimaSincronizacaoOk: estado.ultimaSincronizacaoOk,
    ultimaTentativaEm: estado.ultimaTentativaEm,
    ultimoErro: estado.ultimoErro,
    configAtualizadaEm: estado.configAtualizadaEm,
    agenteSincronizadoEm: estado.agenteSincronizadoEm,
    pollIntervalMs,
  };
}

function reagendarPoll() {
  if (!intervalHandle || !lerConfigFnRef) return;
  clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    void sincronizar(lerConfigFnRef).catch((e) =>
      log.warn("[ConfigSync] Erro no poll:", e.message),
    );
  }, pollIntervalMs);
  log.info(`[ConfigSync] Intervalo de poll atualizado: ${pollIntervalMs}ms`);
}

function aplicarFiscalRuntime(valor) {
  estado.fiscalEnabled = !!valor;
  if (acbrRef && typeof acbrRef.setRuntimeEmissaoFiscal === "function") {
    acbrRef.setRuntimeEmissaoFiscal(valor);
  }
  process.env.EMISSAO_FISCAL = valor ? "true" : "false";
}

function limparOverrideFiscalParaEnv() {
  estado.fiscalEnabled = obterEnvFallbackFiscal();
  if (acbrRef && typeof acbrRef.setRuntimeEmissaoFiscal === "function") {
    acbrRef.setRuntimeEmissaoFiscal(null);
  }
  process.env.EMISSAO_FISCAL = estado.fiscalEnabled ? "true" : "false";
}

function obterEmissaoFiscalLocal() {
  try {
    const fiscalLocalConfig = require("./fiscalLocalConfig");
    return fiscalLocalConfig.lerEmissaoFiscalRuntime();
  } catch (_) {
    return obterEnvFallbackFiscal();
  }
}

function sincronizarEmissaoFiscalLocal() {
  const authority = fiscalConfigAuthority.obterStatus();
  const emissao = authority.ativo
    ? authority.localEmissaoFiscal
    : obterEmissaoFiscalLocal();
  aplicarFiscalRuntime(emissao);
  estado.fonte = authority.ativo ? "agente_local" : "env";
  return emissao;
}

function painelConfigurouFiscal(cfg) {
  return cfg.configAtualizadaEm != null && cfg.configAtualizadaEm !== "";
}

function aplicarConfigRemota(cfg) {
  if (!cfg || typeof cfg !== "object") return;

  sincronizarEmissaoFiscalLocal();
  if (typeof cfg.fiscalEnabled === "boolean" && painelConfigurouFiscal(cfg)) {
    const authority = fiscalConfigAuthority.obterStatus();
    if (!authority.ativo && cfg.fiscalEnabled !== estado.fiscalEnabled) {
      log.debug(
        { backend: cfg.fiscalEnabled, local: estado.fiscalEnabled },
        "[ConfigSync] fiscalEnabled do backend ignorado — SSOT no agente local",
      );
    }
  }

  if (typeof cfg.somErroProdutoNaoEncontrado === "boolean") {
    estado.somErroProdutoNaoEncontrado = cfg.somErroProdutoNaoEncontrado;
  }
  if (typeof cfg.avisoObrigatorioProdutoNaoCadastrado === "boolean") {
    estado.avisoObrigatorioProdutoNaoCadastrado =
      cfg.avisoObrigatorioProdutoNaoCadastrado;
  }

  if (cfg.operacional && typeof cfg.operacional === "object") {
    const merged = runtimeConfig.aplicarRemoto(cfg.operacional);
    estado.operacional = merged;
    const novoPoll = merged.configPollIntervalMs;
    if (
      typeof novoPoll === "number" &&
      novoPoll >= 15000 &&
      novoPoll !== pollIntervalMs
    ) {
      pollIntervalMs = novoPoll;
      reagendarPoll();
    }
  }

  estado.configAtualizadaEm = cfg.configAtualizadaEm || null;
  estado.agenteSincronizadoEm = cfg.agenteSincronizadoEm || null;
  estado.ultimaSincronizacaoOk = new Date().toISOString();
  estado.ultimoErro = null;
}

async function enviarHeartbeat(backendUrl, backendToken) {
  const fetch = require("node-fetch");
  const fiscalTrace = require("./fiscalTraceLog");
  const filaFiscal = require("./filaFiscal");
  const providerId =
    process.env.ACBR_DRIVER === "lib" ? "agent-local-lib" : "agent-local-monitor";
  let filaStatus = {};
  try {
    filaStatus = filaFiscal.status() || {};
  } catch {
    /* ignore */
  }
  try {
    const resp = await fetch(`${backendUrl}/pdv/agente/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${backendToken}`,
      },
      body: JSON.stringify({
        providerId,
        filaFiscal: {
          pendentes: filaStatus.pendentes ?? 0,
          incerto: filaStatus.incerto ?? 0,
          processando: filaStatus.processando ?? 0,
        },
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      fiscalTrace.warn("Heartbeat", "Backend rejeitou heartbeat", {
        status: resp.status,
        body: txt.slice(0, 120),
      });
      log.debug({ status: resp.status, body: txt.slice(0, 80) }, "[ConfigSync] heartbeat HTTP");
    } else {
      fiscalTrace.trace("Heartbeat", "OK — agente online no backend", { providerId });
    }
  } catch (err) {
    fiscalTrace.warn("Heartbeat", "Falha ao enviar heartbeat", { err: err.message });
    log.debug({ err: err.message }, "[ConfigSync] heartbeat falhou");
  }
}

async function enviarAck(backendUrl, backendToken) {
  const fetch = require("node-fetch");
  const resp = await fetch(`${backendUrl}/pdv/agente/config/ack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ACK HTTP ${resp.status}: ${txt.slice(0, 120)}`);
  }
  return resp.json();
}

async function sincronizar(lerConfigFn) {
  if (sincronizando) return getStatus();
  sincronizando = true;
  try {
    estado.ultimaTentativaEm = new Date().toISOString();
    const cfg = await lerConfigFn();
  const backendUrl = cfg.backendUrl || process.env.BACKEND_URL || "";
  const backendToken = cfg.backendToken || process.env.BACKEND_TOKEN || "";

  if (!backendUrl || !backendToken) {
    runtimeConfig.manterUltimoConhecido();
    estado.fonte =
      estado.fiscalEnabled !== null || estado.operacional
        ? "ultimo_conhecido"
        : "env";
    return getStatus();
  }

  const fetch = require("node-fetch");
  try {
    const resp = await fetch(`${backendUrl}/pdv/agente/config`, {
      headers: {
        Authorization: `Bearer ${backendToken}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
    }
    const remoto = await resp.json();
    aplicarConfigRemota(remoto);
    try {
      const ack = await enviarAck(backendUrl, backendToken);
      if (ack && ack.agenteSincronizadoEm) {
        estado.agenteSincronizadoEm = ack.agenteSincronizadoEm;
      }
    } catch (ackErr) {
      log.warn("[ConfigSync] Config aplicada, ACK falhou:", ackErr.message);
    }
    await enviarHeartbeat(backendUrl, backendToken);
  } catch (err) {
    estado.ultimoErro = err.message;
    runtimeConfig.manterUltimoConhecido();
    estado.fonte =
      estado.fiscalEnabled !== null || estado.operacional
        ? "ultimo_conhecido"
        : "env";
    log.warn({ err: err.message }, "[ConfigSync] Falha ao sincronizar");
  }
  return getStatus();
  } finally {
    sincronizando = false;
  }
}

function iniciar(lerConfigFn, acbr) {
  acbrRef = acbr;
  lerConfigFnRef = lerConfigFn;
  sincronizarEmissaoFiscalLocal();
  if (intervalHandle) return;
  void sincronizar(lerConfigFn);
  intervalHandle = setInterval(() => {
    void sincronizar(lerConfigFn).catch((e) =>
      log.warn("[ConfigSync] Erro no poll:", e.message),
    );
  }, pollIntervalMs);
  log.info(`[ConfigSync] Polling a cada ${pollIntervalMs}ms`);
}

function parar() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  iniciar,
  parar,
  sincronizar,
  getStatus,
  aplicarConfigRemota,
  POLL_INTERVAL_MS: () => pollIntervalMs,
};
