/**
 * Sessão persistente ACBrLib — evita Inicializar/Finalizar por operação.
 *
 * Regras de solidez (Windows + koffi + @projetoacbr):
 * - NFe e NFS-e têm slots separados (DLLs/classes diferentes).
 * - Handle morto (void**): abandonar SEM Finalizar e SEM Symbol.dispose
 *   (dispose do wrapper oficial chama Finalizar e envenena o koffi).
 * - Processo envenenado → recycle automático do serviço (exit 1).
 * - Idle Finalizar desligado por padrão (ACBR_LIB_SESSION_IDLE_MS=0).
 * - withAcbrLock é reentrante (ALS).
 */
const path = require("path");
const log = require("../../logger").child({ modulo: "acbr_lib_session" });
const processRecycle = require("./acbrLibProcessRecycle");

/** @type {Record<string, { inst: object, runtime: object, createdAt: number, generation: number, slot: string }|null>} */
const slots = { nfe: null, nfse: null };
/** @type {Record<string, string|null>} */
const fingerprints = { nfe: null, nfse: null };
/** @type {Record<string, ReturnType<typeof setTimeout>|null>} */
const idleTimers = { nfe: null, nfse: null };
/** @type {Record<string, object|null>} */
const cachedRuntimes = { nfe: null, nfse: null };
/** @type {Record<string, string|null>} */
const cachedRuntimeFps = { nfe: null, nfse: null };

let idleSuspended = 0;
let lastKoffiDeadAt = 0;
let generationSeq = 0;
/** Após Inicializar ou soft-abandon, não sobrescrever DLLs mapeadas no processo. */
let dllPinned = false;
/** Soft-dead por slot: cooldown curto antes de re-Inicializar (não brick permanente). */
const softDeadUntilRecycle = { nfe: false, nfse: false };
/** @type {Record<string, number>} */
const softDeadAt = { nfe: 0, nfse: 0 };

const IDLE_MS = parseInt(process.env.ACBR_LIB_SESSION_IDLE_MS || "0", 10);
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

function isHoldingAcbrLockSafe() {
  try {
    return require("../../acbr").isHoldingAcbrLock() === true;
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
  if (IDLE_MS <= 0) return; // idle Finalizar desligado — sessão quente (produção)
  if (idleSuspended > 0 || !slots[key]) return;
  // Busy check ANTES do lock — dentro do lock isAcbrBusy sempre true (depth++).
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
  const softReason =
    reason === "koffi_dead" ||
    reason === "testar_soft" ||
    reason === "watchdog_soft" ||
    reason === "sefaz_status_soft";
  for (const key of keys) {
    clearIdleTimer(key);
    const active = slots[key];
    if (!active) {
      // Sem handle vivo: NÃO marcar soft-dead (isso brickava o caixa após testar/preflight).
      if (softReason) lastKoffiDeadAt = Date.now();
      continue;
    }
    // Só adia idle se outro dono segura o recurso — sob o próprio lock (reentrante) finaliza.
    if (
      reason === "idle_timeout" &&
      isAcbrBusySafe() &&
      !isHoldingAcbrLockSafe()
    ) {
      scheduleIdleFinalizeSlot(key);
      continue;
    }
    const { inst } = active;
    slots[key] = null;
    fingerprints[key] = null;

    if (softReason) {
      lastKoffiDeadAt = Date.now();
      dllPinned = true;
      softDeadUntilRecycle[key] = true;
      softDeadAt[key] = Date.now();
      // NÃO chamar Symbol.dispose / Finalizar — o wrapper oficial (@projetoacbr)
      // faz Finalizar no dispose e isso gera void** permanente no processo.
      log.warn({ reason, slot: key }, "[ACBrLibSession] Sessão abandonada sem Finalizar");
      continue;
    }

    try {
      inst.finalizar();
      log.info({ reason, slot: key }, "[ACBrLibSession] Sessão finalizada");
    } catch (err) {
      lastKoffiDeadAt = Date.now();
      dllPinned = true;
      softDeadUntilRecycle[key] = true;
      softDeadAt[key] = Date.now();
      log.warn(
        { err: err.message, reason, slot: key },
        "[ACBrLibSession] Finalizar falhou — sessão abandonada",
      );
    }
  }
}

const SOFTDEAD_COOLDOWN_MS = parseInt(
  process.env.ACBR_LIB_SOFTDEAD_COOLDOWN_MS || "1500",
  10,
);

/**
 * Soft-dead: após abandonar handle vivo, espera cooldown curto e tenta Inicializar de novo.
 * Nunca bloqueia o caixa para sempre — só evita reentrada imediata no mesmo tick.
 */
function allowSoftDeadRecovery(key) {
  if (!softDeadUntilRecycle[key]) return true;
  const at = softDeadAt[key] || lastKoffiDeadAt || 0;
  const age = Date.now() - at;
  if (age >= Math.max(500, SOFTDEAD_COOLDOWN_MS)) {
    softDeadUntilRecycle[key] = false;
    softDeadAt[key] = 0;
    log.info(
      { slot: key, cooldownMs: age },
      "[ACBrLibSession] Soft-dead liberado — nova Inicializar permitida",
    );
    return true;
  }
  return false;
}

/**
 * @param {object} runtime
 * @param {new (...args: any[]) => any} LibClass
 */
async function ensureSession(runtime, LibClass) {
  const key = resolveSlotKey(runtime);
  if (processRecycle.isProcessPoisoned()) {
    const e = new Error(
      "ACBrLib koffi envenenado — o serviço do agente está reiniciando automaticamente",
    );
    e.reiniciarAcbr = true;
    e.softDead = true;
    e.processPoisoned = true;
    e.retryable = true;
    processRecycle.scheduleRecycle("ensure_session_poisoned");
    throw e;
  }
  if (softDeadUntilRecycle[key] && !allowSoftDeadRecovery(key)) {
    const e = new Error(
      "ACBrLib sessão nativa em recuperação — aguarde 1–2s e tente novamente",
    );
    e.reiniciarAcbr = true;
    e.softDead = true;
    e.retryable = true;
    throw e;
  }
  const fp = fingerprintRuntime(runtime);
  const active = slots[key];
  if (active && fingerprints[key] === fp) {
    scheduleIdleFinalizeSlot(key);
    return active;
  }

  await destroySession("config_changed", key);
  if (softDeadUntilRecycle[key] && !allowSoftDeadRecovery(key)) {
    const e = new Error(
      "ACBrLib sessão nativa em recuperação — aguarde 1–2s e tente novamente",
    );
    e.reiniciarAcbr = true;
    e.softDead = true;
    e.retryable = true;
    throw e;
  }

  const instPaths = require("./acbrLibRuntime").resolveInstPaths(runtime);
  const gen = ++generationSeq;
  const inst = new LibClass(
    instPaths.libPath,
    instPaths.iniConfig,
    process.env.ACBR_LIB_CRYPT_KEY || "",
  );
  try {
    inst.inicializar();
    dllPinned = true;
    softDeadUntilRecycle[key] = false;
    softDeadAt[key] = 0;
  } catch (err) {
    lastKoffiDeadAt = Date.now();
    dllPinned = true;
    softDeadUntilRecycle[key] = true;
    softDeadAt[key] = Date.now();
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
  const key = resolveSlotKey(runtime);
  const fp = fingerprintRuntime(runtime);
  if (cachedRuntimes[key] && cachedRuntimeFps[key] === fp) return cachedRuntimes[key];
  cachedRuntimes[key] = runtime;
  cachedRuntimeFps[key] = fp;
  return cachedRuntimes[key];
}

function invalidateRuntimeCache(slotKey) {
  if (slotKey === "nfe" || slotKey === "nfse") {
    cachedRuntimes[slotKey] = null;
    cachedRuntimeFps[slotKey] = null;
    return;
  }
  cachedRuntimes.nfe = null;
  cachedRuntimes.nfse = null;
  cachedRuntimeFps.nfe = null;
  cachedRuntimeFps.nfse = null;
}

async function invalidateNativeSession(reason = "manual", slotKey) {
  invalidateRuntimeCache(slotKey);
  await destroySession(reason, slotKey);
}

function recentlyHadKoffiDead(graceMs = KOFFI_WATCHDOG_GRACE_MS) {
  if (!lastKoffiDeadAt) return false;
  return Date.now() - lastKoffiDeadAt < Math.max(5000, graceMs);
}

function isDllPinned() {
  return dllPinned === true;
}

function isSoftDead(slotKey) {
  if (slotKey === "nfe" || slotKey === "nfse") return softDeadUntilRecycle[slotKey] === true;
  return softDeadUntilRecycle.nfe || softDeadUntilRecycle.nfse;
}

/** Operador / recycle controlado — libera nova Inicializar após soft-dead. */
function clearSoftDead(slotKey) {
  if (slotKey === "nfe" || slotKey === "nfse") {
    softDeadUntilRecycle[slotKey] = false;
    softDeadAt[slotKey] = 0;
    return;
  }
  softDeadUntilRecycle.nfe = false;
  softDeadUntilRecycle.nfse = false;
  softDeadAt.nfe = 0;
  softDeadAt.nfse = 0;
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
    dllPinned,
    softDead: softDeadUntilRecycle.nfe || softDeadUntilRecycle.nfse,
    softDeadNfe: softDeadUntilRecycle.nfe,
    softDeadNfse: softDeadUntilRecycle.nfse,
    processPoisoned: processRecycle.isProcessPoisoned(),
    recycle: processRecycle.getRecycleStatus(),
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

/** Testes: limpa pin/soft-dead sem reciclar o processo. */
function resetDllPinForTests() {
  dllPinned = false;
  lastKoffiDeadAt = 0;
  softDeadUntilRecycle.nfe = false;
  softDeadUntilRecycle.nfse = false;
  softDeadAt.nfe = 0;
  softDeadAt.nfse = 0;
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
  isDllPinned,
  isSoftDead,
  clearSoftDead,
  scheduleIdleFinalize,
  suspendIdle,
  resumeIdle,
  fingerprintRuntime,
  resolveSlotKey,
  resetDllPinForTests,
};
