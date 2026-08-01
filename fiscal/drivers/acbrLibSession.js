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
/** Timestamp do último abandon soft por koffi — watchdog não abre contingência. */
let lastKoffiDeadAt = 0;

const IDLE_MS = parseInt(process.env.ACBR_LIB_SESSION_IDLE_MS || "120000", 10);
const IDLE_BUSY_POLL_MS = parseInt(process.env.ACBR_LIB_IDLE_BUSY_POLL_MS || "5000", 10);
const KOFFI_WATCHDOG_GRACE_MS = parseInt(
  process.env.ACBR_LIB_KOFFI_WATCHDOG_GRACE_MS || "90000",
  10,
);

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
  let iniFp = "";
  if (runtime.iniConfig) {
    try {
      const raw = fs.readFileSync(runtime.iniConfig, "utf8");
      iniFp = require("crypto").createHash("sha256").update(raw).digest("hex").slice(0, 20);
    } catch (_) {
      iniFp = String(runtime.iniConfig);
    }
  }
  return [
    runtime.libPath,
    runtime.iniConfig,
    iniFp,
    runtime.tpAmb,
    runtime.ambienteLib || "",
    runtime.ambienteSefaz || "",
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
    /inicializar|finalizar|dll|access violation|invalid handle|biblioteca|unexpected external|void \*\*/i.test(
      msg,
    ) || err?.reiniciarAcbr === true
  );
}

/** Handle koffi já morto — Finalizar piora / repete void**. */
function isKoffiDeadHandleError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return /unexpected external|void \*\*|access violation|invalid handle/i.test(msg);
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

  // Sessão morta (koffi): abandonar sem Finalizar — evita cascata void**.
  if (
    reason === "koffi_dead" ||
    reason === "testar_soft" ||
    reason === "watchdog_soft" ||
    reason === "sefaz_status_soft"
  ) {
    lastKoffiDeadAt = Date.now();
    log.warn({ reason }, "[ACBrLibSession] Sessão abandonada sem Finalizar (handle inválido)");
    return;
  }

  try {
    inst.finalizar();
    log.info({ reason }, "[ACBrLibSession] Sessão finalizada");
  } catch (err) {
    log.warn(
      { err: err.message, reason },
      "[ACBrLibSession] Finalizar falhou — sessão abandonada",
    );
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

function recentlyHadKoffiDead(graceMs = KOFFI_WATCHDOG_GRACE_MS) {
  if (!lastKoffiDeadAt) return false;
  return Date.now() - lastKoffiDeadAt < Math.max(5000, graceMs);
}

function getSessionStatus() {
  return {
    ativa: !!activeSession,
    criadaEm: activeSession?.createdAt || null,
    idleMs: IDLE_MS,
    idleSuspended: idleSuspended > 0,
    runtimeFingerprint: runtimeFingerprint || null,
    lastKoffiDeadAt: lastKoffiDeadAt || null,
  };
}

module.exports = {
  ensureSession,
  cacheRuntime,
  invalidateRuntimeCache,
  invalidateNativeSession,
  getSessionStatus,
  shouldInvalidateOnError,
  isKoffiDeadHandleError,
  recentlyHadKoffiDead,
  scheduleIdleFinalize,
  suspendIdle,
  resumeIdle,
  fingerprintRuntime,
};
