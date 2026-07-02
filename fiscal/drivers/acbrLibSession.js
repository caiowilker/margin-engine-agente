/**
 * Sessão persistente ACBrLib — evita NFE_Inicializar/Finalizar por operação.
 * Uma emissão por vez (mutex global em acbr.withAcbrLock + fiscalEmissionLock).
 */
const log = require("../../logger").child({ modulo: "acbr_lib_session" });

let activeSession = null;
let runtimeFingerprint = null;
let cachedRuntime = null;
let cachedRuntimeFp = null;
let idleTimer = null;
let idleSuspended = 0;

const IDLE_MS = parseInt(process.env.ACBR_LIB_SESSION_IDLE_MS || "120000", 10);
const IDLE_BUSY_POLL_MS = parseInt(process.env.ACBR_LIB_IDLE_BUSY_POLL_MS || "5000", 10);

const fs = require("fs");

function isAcbrBusySafe() {
  try {
    return require("../../acbr").isAcbrBusy();
  } catch (_) {
    return false;
  }
}

function fingerprintRuntime(runtime) {
  if (!runtime) return "";
  let iniMtime = "";
  if (runtime.iniConfig) {
    try {
      iniMtime = String(fs.statSync(runtime.iniConfig).mtimeMs);
    } catch (_) {
      iniMtime = String(runtime.iniConfig);
    }
  }
  return [
    runtime.libPath,
    runtime.iniConfig,
    iniMtime,
    runtime.tpAmb,
    runtime.cert || runtime.certRel || "",
    runtime.idCsc || "",
    runtime.senha ? "1" : "0",
    runtime.csc ? "1" : "0",
  ].join("|");
}

function suspendIdle() {
  idleSuspended++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resumeIdle() {
  idleSuspended = Math.max(0, idleSuspended - 1);
  if (idleSuspended === 0 && activeSession) {
    scheduleIdleFinalize();
  }
}

function scheduleIdleFinalize() {
  if (idleTimer) clearTimeout(idleTimer);
  if (idleSuspended > 0 || !activeSession) return;
  if (isAcbrBusySafe()) {
    idleTimer = setTimeout(() => scheduleIdleFinalize(), IDLE_BUSY_POLL_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
    return;
  }
  idleTimer = setTimeout(() => {
    void invalidateNativeSession("idle_timeout");
  }, IDLE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function shouldInvalidateOnError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    /inicializar|finalizar|dll|access violation|invalid handle|biblioteca/i.test(msg) ||
    err?.reiniciarAcbr === true
  );
}

async function destroySession(reason) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!activeSession) return;
  if (isAcbrBusySafe() && reason === "idle_timeout") {
    scheduleIdleFinalize();
    return;
  }
  const { inst } = activeSession;
  activeSession = null;
  runtimeFingerprint = null;
  try {
    inst.finalizar();
    log.info({ reason }, "[ACBrLibSession] Sessão finalizada");
  } catch (err) {
    log.debug({ err: err.message, reason }, "[ACBrLibSession] Finalizar ignorado");
  }
}

/**
 * @param {object} runtime
 * @param {typeof import('@projetoacbr/acbrlib-nfe-node/dist/src').default} LibClass
 */
async function ensureSession(runtime, LibClass) {
  const fp = fingerprintRuntime(runtime);
  if (activeSession && runtimeFingerprint === fp) {
    scheduleIdleFinalize();
    return activeSession;
  }

  await destroySession("config_changed");

  const instPaths = require("./acbrLibRuntime").resolveInstPaths(runtime);
  const inst = new LibClass(instPaths.libPath, instPaths.iniConfig, process.env.ACBR_LIB_CRYPT_KEY || "");
  inst.inicializar();
  require("./acbrLibRuntime").applyNativeRuntimeConfig(inst, runtime);
  require("./acbrLibRuntime").applyNativeCertConfig(inst, runtime);

  activeSession = { inst, runtime, createdAt: Date.now() };
  runtimeFingerprint = fp;
  scheduleIdleFinalize();
  log.info("[ACBrLibSession] Sessão nativa inicializada (reuso ativo)");
  return activeSession;
}

function cacheRuntime(runtime) {
  const fp = fingerprintRuntime(runtime);
  if (cachedRuntime && cachedRuntimeFp === fp) return cachedRuntime;
  cachedRuntime = runtime;
  cachedRuntimeFp = fp;
  return cachedRuntime;
}

function invalidateRuntimeCache() {
  cachedRuntime = null;
  cachedRuntimeFp = null;
}

async function invalidateNativeSession(reason = "manual") {
  invalidateRuntimeCache();
  await destroySession(reason);
}

function getSessionStatus() {
  return {
    ativa: !!activeSession,
    criadaEm: activeSession?.createdAt || null,
    idleMs: IDLE_MS,
    idleSuspended: idleSuspended > 0,
    runtimeFingerprint: runtimeFingerprint || null,
  };
}

module.exports = {
  ensureSession,
  cacheRuntime,
  invalidateRuntimeCache,
  invalidateNativeSession,
  getSessionStatus,
  shouldInvalidateOnError,
  scheduleIdleFinalize,
  suspendIdle,
  resumeIdle,
};
