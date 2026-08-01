/**
 * Sessão persistente ACBrLib — evita Inicializar/Finalizar por operação.
 *
 * Regras de solidez (Windows + koffi):
 * - NFe e NFS-e têm slots separados (DLLs/classes diferentes).
 * - Idle finalize SEMPRE sob withAcbrLock (sem corrida com emissão).
 * - Handle morto (void**): abandonar sem Finalizar.
 * - Generation id: nunca reutilizar inst após dispose.
 */
const path = require("path");
const fs = require("fs");
const log = require("../../logger").child({ modulo: "acbr_lib_session" });

/** @type {Record<string, { inst: object, runtime: object, createdAt: number, generation: number, slot: string }|null>} */
const slots = { nfe: null, nfse: null };
/** @type {Record<string, string|null>} */
const fingerprints = { nfe: null, nfse: null };
/** @type {Record<string, ReturnType<typeof setTimeout>|null>} */
const idleTimers = { nfe: null, nfse: null };

let cachedRuntime = null;
let cachedRuntimeFp = null;
let idleSuspended = 0;
let lastKoffiDeadAt = 0;
let generationSeq = 0;

const IDLE_MS = parseInt(process.env.ACBR_LIB_SESSION_IDLE_MS || "300000", 10);
const IDLE_BUSY_POLL_MS = parseInt(process.env.ACBR_LIB_IDLE_BUSY_POLL_MS || "5000", 10);
const KOFFI_WATCHDOG_GRACE_MS = parseInt(
  process.env.ACBR_LIB_KOFFI_WATCHDOG_GRACE_MS || "120000",
  10,
);

function isAcbrBusySafe() {
  try {
    return require("../../acbr").isAcbrBusy();
  } catch (_) {
    return false;
  }
}

function withAcbrLockSafe(fn, label) {
  try {
    return require("../../acbr").withAcbrLock(fn, label);
  } catch (_) {
    return fn();
  }
}

/** Slot por DLL: NFe vs NFS-e nunca compartilham o mesmo handle koffi. */
function resolveSlotKey(runtimeOrLibPath) {
  const lib =
    typeof runtimeOrLibPath === "string"
      ? runtimeOrLibPath
      : runtimeOrLibPath?.libPath || "";
  const base = path.basename(String(lib)).toLowerCase();
  if (base.includes("nfse")) return "nfse";
  return "nfe";
}

function normPath(p) {
  return path.normalize(String(p || "")).toLowerCase();
}

function fingerprintRuntime(runtime) {
  if (!runtime) return "";
  // NÃO hashear o conteúdo do INI: a Lib grava valores em runtime (configGravarValor)
  // e isso invalidava a sessão → Finalizar/Inicializar → void** no koffi.
  return [
    resolveSlotKey(runtime),
    normPath(runtime.libPath),
    normPath(runtime.iniConfig),
    String(runtime.tpAmb || ""),
    String(runtime.ambienteLib || ""),
    String(runtime.ambienteSefaz || ""),
    normPath(runtime.cert || runtime.certRel || ""),
    String(runtime.idCsc || ""),
    runtime.senha ? "1" : "0",
    runtime.csc ? "1" : "0",
  ].join("|");
}

function suspendIdle() {
  idleSuspended++;
  for (const key of Object.keys(idleTimers)) {
    if (idleTimers[key]) {
      clearTimeout(idleTimers[key]);
      idleTimers[key] = null;
    }
  }
}

function resumeIdle() {
  idleSuspended = Math.max(0, idleSuspended - 1);
  if (idleSuspended === 0) {
    for (const key of Object.keys(slots)) {
      if (slots[key]) scheduleIdleFinalizeSlot(key);
    }
  }
}

function clearIdleTimer(key) {
  if (idleTimers[key]) {
    clearTimeout(idleTimers[key]);
    idleTimers[key] = null;
  }
}

function scheduleIdleFinalizeSlot(slotKey = "nfe") {
  const key = slotKey === "nfse" ? "nfse" : "nfe";
  clearIdleTimer(key);
  if (idleSuspended > 0 || !slots[key]) return;
  if (isAcbrBusySafe()) {
    idleTimers[key] = setTimeout(() => scheduleIdleFinalizeSlot(key), IDLE_BUSY_POLL_MS);
    if (typeof idleTimers[key].unref === "function") idleTimers[key].unref();
    return;
  }
  idleTimers[key] = setTimeout(() => {
    // CRÍTICO: idle finalize sob o mesmo mutex das operações nativas.
    void withAcbrLockSafe(async () => {
      await destroySession("idle_timeout", key);
    }, `lib-idle-${key}`);
  }, IDLE_MS);
  if (typeof idleTimers[key].unref === "function") idleTimers[key].unref();
}

function shouldInvalidateOnError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    /inicializar|finalizar|dll|access violation|invalid handle|biblioteca|unexpected external|void \*\*|session disposed/i.test(
      msg,
    ) || err?.reiniciarAcbr === true
  );
}

function isKoffiDeadHandleError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return /unexpected external|void \*\*|access violation|invalid handle|session disposed/i.test(
    msg,
  );
}

/**
 * @param {string} reason
 * @param {string} [slotKey]
 */
async function destroySession(reason, slotKey) {
  const keys = slotKey ? [slotKey === "nfse" ? "nfse" : "nfe"] : ["nfe", "nfse"];
  for (const key of keys) {
    clearIdleTimer(key);
    const active = slots[key];
    if (!active) continue;
    if (isAcbrBusySafe() && reason === "idle_timeout") {
      scheduleIdleFinalizeSlot(key);
      continue;
    }
    const { inst } = active;
    slots[key] = null;
    fingerprints[key] = null;

    if (
      reason === "koffi_dead" ||
      reason === "testar_soft" ||
      reason === "watchdog_soft" ||
      reason === "sefaz_status_soft"
    ) {
      lastKoffiDeadAt = Date.now();
      log.warn({ reason, slot: key }, "[ACBrLibSession] Sessão abandonada sem Finalizar");
      continue;
    }

    try {
      inst.finalizar();
      log.info({ reason, slot: key }, "[ACBrLibSession] Sessão finalizada");
    } catch (err) {
      lastKoffiDeadAt = Date.now();
      log.warn(
        { err: err.message, reason, slot: key },
        "[ACBrLibSession] Finalizar falhou — sessão abandonada",
      );
    }
  }
}

/**
 * @param {object} runtime
 * @param {new (...args: any[]) => any} LibClass
 */
async function ensureSession(runtime, LibClass) {
  const key = resolveSlotKey(runtime);
  const fp = fingerprintRuntime(runtime);
  const active = slots[key];
  if (active && fingerprints[key] === fp) {
    scheduleIdleFinalizeSlot(key);
    return active;
  }

  await destroySession("config_changed", key);

  const instPaths = require("./acbrLibRuntime").resolveInstPaths(runtime);
  const gen = ++generationSeq;
  const inst = new LibClass(
    instPaths.libPath,
    instPaths.iniConfig,
    process.env.ACBR_LIB_CRYPT_KEY || "",
  );
  try {
    inst.inicializar();
  } catch (err) {
    lastKoffiDeadAt = Date.now();
    throw err;
  }
  require("./acbrLibRuntime").applyNativeRuntimeConfig(inst, runtime);
  require("./acbrLibRuntime").applyNativeCertConfig(inst, runtime);

  const session = {
    inst,
    runtime,
    createdAt: Date.now(),
    generation: gen,
    slot: key,
  };
  slots[key] = session;
  fingerprints[key] = fp;
  scheduleIdleFinalizeSlot(key);
  log.info({ slot: key, generation: gen }, "[ACBrLibSession] Sessão nativa inicializada");
  return session;
}

/** Garante que o handle ainda é o da sessão corrente. */
function assertSessionAlive(session) {
  if (!session?.slot) {
    const e = new Error("ACBrLib session disposed");
    e.reiniciarAcbr = true;
    throw e;
  }
  const current = slots[session.slot];
  if (!current || current.generation !== session.generation || current.inst !== session.inst) {
    const e = new Error("ACBrLib session disposed");
    e.reiniciarAcbr = true;
    throw e;
  }
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

async function invalidateNativeSession(reason = "manual", slotKey) {
  invalidateRuntimeCache();
  await destroySession(reason, slotKey);
}

function recentlyHadKoffiDead(graceMs = KOFFI_WATCHDOG_GRACE_MS) {
  if (!lastKoffiDeadAt) return false;
  return Date.now() - lastKoffiDeadAt < Math.max(5000, graceMs);
}

function getSessionStatus() {
  const nfe = slots.nfe;
  const nfse = slots.nfse;
  return {
    ativa: !!(nfe || nfse),
    nfeAtiva: !!nfe,
    nfseAtiva: !!nfse,
    criadaEm: nfe?.createdAt || nfse?.createdAt || null,
    idleMs: IDLE_MS,
    idleSuspended: idleSuspended > 0,
    runtimeFingerprint: fingerprints.nfe || fingerprints.nfse || null,
    lastKoffiDeadAt: lastKoffiDeadAt || null,
  };
}

/** Compat: sem args renova slots ativos. */
function scheduleIdleFinalize(slotKey) {
  if (slotKey === "nfe" || slotKey === "nfse") {
    return scheduleIdleFinalizeSlot(slotKey);
  }
  if (slots.nfe) scheduleIdleFinalizeSlot("nfe");
  if (slots.nfse) scheduleIdleFinalizeSlot("nfse");
}

module.exports = {
  ensureSession,
  assertSessionAlive,
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
  resolveSlotKey,
};
