// Sincronização periódica de config do terminal com o backend (Parte D + F)
const log = require("./logger").child({ modulo: "config_sync" });
const runtimeConfig = require("./runtimeConfig");
const catalog = require("./agentConfigCatalog");
const fiscalConfigAuthority = require("./fiscalConfigAuthority");

let pollIntervalMs = parseInt(
  process.env.CONFIG_POLL_INTERVAL_MS || "45000",
  10,
);
let heartbeatIntervalMs = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS || "60000",
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
let heartbeatHandle = null;
let acbrRef = null;
let lerConfigFnRef = null;
let sincronizando = false;
/** @type {null | ((ctx: { remoto: object, backendUrl: string, backendToken: string }) => Promise<void>)} */
let onUpdateRequestedFn = null;
let processandoUpdateCloud = false;

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

function reagendarHeartbeat() {
  if (!lerConfigFnRef) return;
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = setInterval(() => {
    void enviarHeartbeatStandalone().catch((e) =>
      log.debug({ err: e.message }, "[ConfigSync] heartbeat interval falhou"),
    );
  }, heartbeatIntervalMs);
  log.info(`[ConfigSync] Heartbeat independente a cada ${heartbeatIntervalMs}ms`);
}

async function enviarHeartbeatStandalone() {
  if (!lerConfigFnRef) return;
  const cfg = await lerConfigFnRef();
  const backendUrl = cfg.backendUrl || process.env.BACKEND_URL || "";
  const backendToken = cfg.backendToken || process.env.BACKEND_TOKEN || "";
  if (!backendUrl || !backendToken) return;
  await enviarHeartbeat(backendUrl, backendToken);
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
  try {
    const fiscalLocalConfig = require("./fiscalLocalConfig");
    fiscalLocalConfig.reconciliarEmissaoComEnv();
    const emissao = fiscalLocalConfig.lerEmissaoFiscalRuntime();
    aplicarFiscalRuntime(emissao);
    const authority = fiscalConfigAuthority.obterStatus();
    estado.fonte = authority.ativo ? "agente_local" : "env";
    return emissao;
  } catch (_) {
    const emissao = obterEnvFallbackFiscal();
    aplicarFiscalRuntime(emissao);
    estado.fonte = "env";
    return emissao;
  }
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
  void sincronizarDanfeLogoRemoto(cfg).catch((err) =>
    log.debug({ err: err.message }, "[ConfigSync] sync logo DANFE falhou"),
  );
}

async function sincronizarDanfeLogoRemoto(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  const backendUrl = cfg.backendUrl || process.env.BACKEND_URL || "";
  const backendToken = cfg.backendToken || process.env.BACKEND_TOKEN || "";
  if (!backendUrl || !backendToken) return;

  const shaRemoto = cfg.danfeLogoSha256 || null;
  const fiscalLogo = require("./fiscal/fiscalLogo");
  const local = fiscalLogo.ler();

  if (!shaRemoto) {
    if (local.sha256Remoto && local.origem === "backend") {
      fiscalLogo.remover();
    }
    return;
  }

  if (!fiscalLogo.precisaSincronizar(shaRemoto) && local.origem === "backend") {
    return;
  }

  const fetch = require("node-fetch");
  const resp = await fetch(`${backendUrl.replace(/\/$/, "")}/pdv/agente/fiscal/logo`, {
    headers: {
      Authorization: `Bearer ${backendToken}`,
      Accept: "image/png, image/jpeg, */*",
    },
  });
  if (resp.status === 404) {
    if (local.origem === "backend") fiscalLogo.remover();
    return;
  }
  if (!resp.ok) {
    throw new Error(`Logo remoto HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fiscalLogo.salvar({
    buffer: buf,
    ativo: true,
    origem: "backend",
    sha256Remoto: shaRemoto,
  });
  log.info({ sha256: shaRemoto }, "[ConfigSync] Logo DANFE sincronizada do backend");
}

async function sincronizarCatalogo(backendUrl, backendToken) {
  const fetch = require("node-fetch");
  try {
    const resp = await fetch(`${backendUrl}/pdv/agente/config/catalog`, {
      headers: {
        Authorization: `Bearer ${backendToken}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      log.debug({ status: resp.status }, "[ConfigSync] catálogo remoto indisponível");
      return;
    }
    const payload = await resp.json();
    const result = catalog.carregarCatalogoRemoto(payload);
    if (result.ok) {
      log.debug(
        { version: result.version, chaves: result.chaves },
        "[ConfigSync] Catálogo operacional sincronizado do backend",
      );
    }
  } catch (err) {
    log.debug({ err: err.message }, "[ConfigSync] Falha ao sincronizar catálogo");
  }
}

async function enviarHeartbeat(backendUrl, backendToken) {
  const fetch = require("node-fetch");
  const fiscalTrace = require("./fiscalTraceLog");
  const filaFiscal = require("./filaFiscal");
  const { montarPayloadHeartbeat } = require("./heartbeatPayload");
  let filaStatus = {};
  try {
    filaStatus = filaFiscal.status() || {};
  } catch {
    /* ignore */
  }
  try {
    const payload = montarPayloadHeartbeat(filaStatus);
    const resp = await fetch(`${backendUrl}/pdv/agente/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${backendToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      fiscalTrace.warn("Heartbeat", "Backend rejeitou heartbeat", {
        status: resp.status,
        body: txt.slice(0, 120),
      });
      log.debug({ status: resp.status, body: txt.slice(0, 80) }, "[ConfigSync] heartbeat HTTP");
    } else {
      fiscalTrace.trace("Heartbeat", "OK — agente online no backend", {
        providerId: payload.providerId,
      });
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

async function enviarUpdateAck(backendUrl, backendToken, payload) {
  const fetch = require("node-fetch");
  const resp = await fetch(`${backendUrl.replace(/\/$/, "")}/pdv/agente/update/ack`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    },
    body: JSON.stringify(payload || { ok: true }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Update ACK HTTP ${resp.status}: ${txt.slice(0, 120)}`);
  }
  return resp.json().catch(() => ({}));
}

async function processarPedidoUpdateCloud(remoto, backendUrl, backendToken) {
  // Sempre tenta confirmar ACK pendente de apply anterior (mesmo sem pedido novo)
  try {
    const updaterCloudPending = require("./updaterCloudPending");
    const manifestUpdater = require("./manifestUpdater");
    const versaoAtual = () => manifestUpdater.lerVersaoInstalada() || "";
    await updaterCloudPending.flushPendingAck({
      enviarAck: (payload) => enviarUpdateAck(backendUrl, backendToken, payload),
      lerVersaoAtual: versaoAtual,
      log,
    });
  } catch (flushErr) {
    log.warn({ err: flushErr.message }, "[ConfigSync] Flush ACK cloud falhou");
  }

  if (!remoto?.aplicarUpdateQuandoOcioso) return;
  if (typeof onUpdateRequestedFn !== "function") {
    log.debug("[ConfigSync] Pedido de update remoto ignorado — handler não registrado");
    return;
  }
  if (processandoUpdateCloud) return;
  processandoUpdateCloud = true;
  try {
    await onUpdateRequestedFn({ remoto, backendUrl, backendToken });
  } catch (err) {
    log.warn({ err: err.message }, "[ConfigSync] Falha ao processar update remoto");
  } finally {
    processandoUpdateCloud = false;
  }
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
    await sincronizarCatalogo(backendUrl, backendToken);
    aplicarConfigRemota(remoto);
    try {
      const ack = await enviarAck(backendUrl, backendToken);
      if (ack && ack.agenteSincronizadoEm) {
        estado.agenteSincronizadoEm = ack.agenteSincronizadoEm;
      }
    } catch (ackErr) {
      log.warn("[ConfigSync] Config aplicada, ACK falhou:", ackErr.message);
    }
    // Após config: pedido de update do cloud (ocioso, nunca force)
    await processarPedidoUpdateCloud(remoto, backendUrl, backendToken);
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
  if (!intervalHandle) {
    void sincronizar(lerConfigFn);
    intervalHandle = setInterval(() => {
      void sincronizar(lerConfigFn).catch((e) =>
        log.warn("[ConfigSync] Erro no poll:", e.message),
      );
    }, pollIntervalMs);
    log.info(`[ConfigSync] Polling a cada ${pollIntervalMs}ms`);
  }
  if (!heartbeatHandle) {
    void enviarHeartbeatStandalone().catch(() => {});
    reagendarHeartbeat();
  }
}

function parar() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

module.exports = {
  iniciar,
  parar,
  sincronizar,
  getStatus,
  aplicarConfigRemota,
  sincronizarEmissaoFiscalLocal,
  setOnUpdateRequested(fn) {
    onUpdateRequestedFn = typeof fn === "function" ? fn : null;
  },
  enviarUpdateAck,
  processarPedidoUpdateCloud,
  POLL_INTERVAL_MS: () => pollIntervalMs,
};
