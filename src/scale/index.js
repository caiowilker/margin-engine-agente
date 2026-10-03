"use strict";

const config = require("./config");
const { ScaleError, sendError, toScaleError } = require("./errors");
const { createSessionManager } = require("./session");
const { createDriver } = require("./driver");
const { listProtocols, resolveProtocol } = require("./protocol/registry");
const {
  createSerialTransport,
  createMockTransport,
  isNativeAvailable,
  getNativeError,
  listPorts,
} = require("./transport/serialPort");
const {
  SCALE_STATUS_CACHE_MS,
  SCALE_LIST_CACHE_MS,
  SCALE_SOFT_ERROR_TTL_MS,
} = require("./constants");
const { createRollingStats } = require("./rollingStats");
const log = require("../../logger").child({ modulo: "scale" });

/** @type {ReturnType<typeof createSessionManager>|null} */
let sessionManager = null;
/** @type {ReturnType<typeof createDriver>|null} */
let driver = null;
let nativeOk = false;
let createTransportFn = null;

const rolling = createRollingStats(50);

const diag = {
  lastOpenAt: null,
  lastError: null,
  lastReadAt: null,
  lastTestAt: null,
  agentVersion: null,
};

const DEGRADED_CODIGOS = new Set([
  "SCALE_USB_GONE",
  "SCALE_OPEN_FAILED",
  "SCALE_NATIVE_MISSING",
]);

const SOFT_CODIGOS = new Set([
  "SCALE_TIMEOUT",
  "SCALE_UNSTABLE",
  "SCALE_INVALID_FRAME",
  "SCALE_PORT_BUSY",
  "SCALE_LOCK_WAIT_TIMEOUT",
]);

function noteError(err) {
  const se = toScaleError(err);
  diag.lastError = { codigo: se.codigo, at: Date.now() };
  if (se.codigo === "SCALE_BUSY") {
    rolling.recordOverlapSkip();
  } else {
    rolling.recordFail(se.codigo);
  }
  if (DEGRADED_CODIGOS.has(se.codigo)) {
    log.warn(
      { metric: "scale.health_degraded", codigo: se.codigo },
      "[Scale] Saúde degradada",
    );
  }
  statusCache = { at: 0, body: null };
  return se;
}

function effectiveLastError() {
  const le = diag.lastError;
  if (!le) return null;
  if (SOFT_CODIGOS.has(le.codigo)) {
    const age = Date.now() - (le.at || 0);
    if (age > SCALE_SOFT_ERROR_TTL_MS) {
      diag.lastError = null;
      return null;
    }
  }
  return le;
}

function buildHealth() {
  const snap = rolling.snapshot();
  const le = effectiveLastError();
  // Soft TTL limpou lastError: não manter warn eterno via rolling.lastCodigo idle.
  const codigo = le?.codigo || null;
  let level = "ok";
  if (!nativeOk) {
    level = "critical";
  } else if (codigo && DEGRADED_CODIGOS.has(codigo)) {
    level = "critical";
  } else if (codigo && SOFT_CODIGOS.has(codigo)) {
    level = "warn";
  }
  return {
    ok: level === "ok",
    level,
    nativeOk,
    lastError: le,
    ...snap,
    lastCodigo: codigo || snap.lastCodigo,
  };
}

let statusCache = { at: 0, body: null };
let portsCache = { at: 0, body: null };

function boot(opts = {}) {
  diag.agentVersion = opts.agentVersion || process.env.npm_package_version || null;
  nativeOk = isNativeAvailable();
  if (!nativeOk) {
    log.warn(
      {
        metric: "scale.native_missing",
        err: getNativeError()?.message,
      },
      "[Scale] serialport ausente — feature degradada",
    );
  }

  createTransportFn = opts.createTransport
    || (nativeOk
      ? (o) => createSerialTransport(o)
      : null);

  sessionManager = createSessionManager({
    createTransport: createTransportFn,
    onUnexpectedClose: ({ sessionId, porta }) => {
      noteError(new ScaleError("SCALE_USB_GONE", { detail: porta || sessionId }));
    },
  });
  driver = createDriver({
    sessionManager,
    createTransport: createTransportFn,
  });

  log.info(
    { metric: "scale.boot", nativeOk, enabled: config.ler().enabled },
    "[Scale] Módulo iniciado",
  );
}

function ensureBooted() {
  if (!sessionManager || !driver) {
    boot();
  }
}

function buildStatusBody() {
  const cfg = config.ler();
  const sess = sessionManager?.get() || null;
  const health = buildHealth();
  return {
    ok: true,
    enabled: cfg.enabled === true,
    porta: cfg.porta || "",
    baud: cfg.baud,
    protocol: cfg.protocol,
    nativeOk,
    session: sess
      ? {
          sessionId: sess.sessionId,
          porta: sess.porta,
          open: sess.open,
          openedAt: sess.openedAt,
          lastActivityAt: sess.lastActivityAt,
        }
      : null,
    lastError: health.lastError,
    health,
  };
}

function registerRoutes(app, { privateNetworkHeaders, exigirAgentToken }) {
  ensureBooted();

  app.get("/scale/status", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const now = Date.now();
      const sess = sessionManager?.get();
      const busy = Boolean(sess?.reading);
      if (
        statusCache.body &&
        now - statusCache.at < SCALE_STATUS_CACHE_MS &&
        (busy || !req.query.fresh)
      ) {
        return res.json(statusCache.body);
      }
      const body = buildStatusBody();
      statusCache = { at: now, body };
      return res.json(body);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get("/scale/config", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      return res.json({ ok: true, ...config.ler() });
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.put("/scale/config", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const saved = config.salvar(req.body || {});
      statusCache = { at: 0, body: null };
      log.info(
        { metric: "scale.protocol_selected", protocol: saved.protocol },
        "[Scale] Protocolo selecionado",
      );
      return res.json({ ok: true, ...saved });
    } catch (err) {
      if (err instanceof ScaleError) return sendError(res, err);
      return res.status(400).json({
        ok: false,
        erro: err.message || "Config inválida",
        codigo: "SCALE_NOT_CONFIGURED",
        acaoRecomendada: "Corrija os campos e salve.",
        recuperavel: true,
      });
    }
  });

  app.get("/scale/ports", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      if (!nativeOk) throw new ScaleError("SCALE_NATIVE_MISSING");
      const now = Date.now();
      if (portsCache.body && now - portsCache.at < SCALE_LIST_CACHE_MS && !req.query.fresh) {
        return res.json(portsCache.body);
      }
      const ports = await listPorts();
      const body = { ok: true, ports };
      portsCache = { at: now, body };
      return res.json(body);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get("/scale/protocols", privateNetworkHeaders, exigirAgentToken, (_req, res) => {
    try {
      return res.json({ ok: true, protocols: listProtocols() });
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/scale/sessao", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = config.ler();
      if (!cfg.enabled) throw new ScaleError("SCALE_DISABLED");
      if (!nativeOk || !createTransportFn) throw new ScaleError("SCALE_NATIVE_MISSING");

      const porta = String(req.body?.porta || cfg.porta || "").trim();
      const baud = Number(req.body?.baud || cfg.baud);
      const protocol = req.body?.protocol || cfg.protocol;
      const pricePerKg =
        req.body?.pricePerKg != null ? Number(req.body.pricePerKg) : null;

      if (!porta) throw new ScaleError("SCALE_NOT_CONFIGURED");

      const sess = await sessionManager.openSession({
        porta,
        baud,
        protocol,
        pricePerKg,
      });
      diag.lastOpenAt = Date.now();
      diag.lastError = null;
      statusCache = { at: 0, body: null };

      // Envia preço 1× se informado (best-effort)
      if (pricePerKg != null && Number.isFinite(pricePerKg)) {
        await driver.sendPricePerKg(pricePerKg).catch(() => {});
      }

      return res.json({ ok: true, sessionId: sess.sessionId, porta: sess.porta });
    } catch (err) {
      noteError(err);
      return sendError(res, err);
    }
  });

  app.post("/scale/sessao/fechar", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
      const result = await sessionManager.closeSession({
        reason: "client",
        sessionId,
      });
      statusCache = { at: 0, body: null };
      return res.json({ ok: true, ...result });
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post("/scale/peso", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = config.ler();
      if (!cfg.enabled) throw new ScaleError("SCALE_DISABLED");
      if (!nativeOk) throw new ScaleError("SCALE_NATIVE_MISSING");

      const sessionId = req.body?.sessionId || null;
      const result = await driver.readWeight({ sessionId });
      diag.lastReadAt = Date.now();

      if (result.ok === false && result.codigo === "SCALE_UNSTABLE") {
        rolling.recordFail("SCALE_UNSTABLE");
        diag.lastError = { codigo: "SCALE_UNSTABLE", at: Date.now() };
        return res.status(409).json(result);
      }
      rolling.recordOk(result.latencyMs);
      if (result.ok) diag.lastError = null;
      statusCache = { at: 0, body: null };
      return res.json(result);
    } catch (err) {
      noteError(err);
      statusCache = { at: 0, body: null };
      return sendError(res, err);
    }
  });

  app.post("/scale/teste", privateNetworkHeaders, exigirAgentToken, async (req, res) => {
    try {
      const cfg = config.ler();
      if (!nativeOk || !createTransportFn) throw new ScaleError("SCALE_NATIVE_MISSING");

      const porta = String(req.body?.porta || cfg.porta || "").trim();
      const baud = Number(req.body?.baud || cfg.baud);
      if (!porta) throw new ScaleError("SCALE_NOT_CONFIGURED");

      const protocol = req.body?.protocol || cfg.protocol;
      // Teste não exige enabled — painel precisa validar antes de ligar
      const result = await driver.testOnce({ porta, baud, protocol });
      diag.lastTestAt = Date.now();
      diag.lastError = null;
      rolling.recordOk(result.latencyMs);
      return res.json(result);
    } catch (err) {
      noteError(err);
      return sendError(res, err);
    }
  });

  app.get("/scale/diagnostico", privateNetworkHeaders, exigirAgentToken, (req, res) => {
    try {
      const cfg = config.ler();
      const sess = sessionManager?.get();
      const proto = resolveProtocol(cfg.protocol);
      const health = buildHealth();
      return res.json({
        ok: true,
        porta: cfg.porta,
        protocol: cfg.protocol,
        baud: cfg.baud,
        stopBits: proto.serial.stopBits,
        enabled: cfg.enabled,
        nativeOk,
        sessionAtiva: Boolean(sess?.open),
        sessionId: sess?.sessionId || null,
        lastOpenAt: diag.lastOpenAt,
        lastReadAt: diag.lastReadAt,
        lastTestAt: diag.lastTestAt,
        lastError: diag.lastError,
        agentVersion: diag.agentVersion,
        protocols: listProtocols().map((p) => p.id),
        health,
        readsOk: health.readsOk,
        readsFail: health.readsFail,
        overlapSkips: health.overlapSkips,
        p50LatencyMs: health.p50LatencyMs,
        p95LatencyMs: health.p95LatencyMs,
        lastCodigo: health.lastCodigo,
      });
    } catch (err) {
      return sendError(res, err);
    }
  });
}

/** @internal testes */
function _testHooks() {
  return {
    boot,
    sessionManager,
    driver,
    createMockTransport,
    setTransportFactory(fn) {
      createTransportFn = fn;
      nativeOk = true;
      sessionManager = createSessionManager({
        createTransport: fn,
        onUnexpectedClose: ({ sessionId, porta }) => {
          noteError(new ScaleError("SCALE_USB_GONE", { detail: porta || sessionId }));
        },
      });
      driver = createDriver({ sessionManager, createTransport: fn });
    },
    resetDiag() {
      diag.lastOpenAt = null;
      diag.lastError = null;
      diag.lastReadAt = null;
      diag.lastTestAt = null;
      rolling.reset();
      statusCache = { at: 0, body: null };
      portsCache = { at: 0, body: null };
    },
    rolling,
  };
}

module.exports = {
  boot,
  registerRoutes,
  _testHooks,
};
