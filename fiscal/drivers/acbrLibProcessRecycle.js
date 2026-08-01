/**
 * Reciclagem do processo Node quando koffi/ACBrLib fica irrecuperável (void**).
 * No Windows (serviço), exit(1) faz o SCM/node-windows subir o agente limpo.
 */
const log = require("../../logger").child({ modulo: "acbr_lib_recycle" });

let processPoisoned = false;
let recycleScheduled = false;
let recycleAt = 0;
let onRecycleHook = null;

function isAutoRecycleEnabled() {
  return String(process.env.ACBR_LIB_AUTO_RECYCLE || "true").toLowerCase() !== "false";
}

function recycleDelayMs() {
  return parseInt(process.env.ACBR_LIB_RECYCLE_DELAY_MS || "2500", 10);
}

function isProcessPoisoned() {
  return processPoisoned === true;
}

function markProcessPoisoned(reason = "koffi_void") {
  if (!processPoisoned) {
    processPoisoned = true;
    log.error(
      { reason, metric: "acbrlib.process_poisoned" },
      "[ACBrLib] Processo envenenado (koffi) — emissão nativa bloqueada até recycle",
    );
  }
  scheduleRecycle(reason);
}

function scheduleRecycle(reason = "koffi_void") {
  if (!isAutoRecycleEnabled()) {
    log.warn(
      { reason },
      "[ACBrLib] AUTO_RECYCLE=false — reinicie o serviço do agente manualmente",
    );
    return false;
  }
  if (recycleScheduled) return true;
  recycleScheduled = true;
  const delay = Math.max(500, recycleDelayMs());
  recycleAt = Date.now() + delay;
  log.error(
    { reason, delayMs: delay, metric: "acbrlib.process_recycle" },
    "[ACBrLib] Reciclando processo do agente para limpar koffi/DLL",
  );
  setTimeout(() => {
    try {
      if (typeof onRecycleHook === "function") {
        Promise.resolve(onRecycleHook(reason))
          .catch(() => {})
          .finally(() => process.exit(1));
        return;
      }
    } catch (_) {}
    process.exit(1);
  }, delay).unref?.();
  return true;
}

/** Permite index.js registrar encerrarGracefully antes do exit. */
function setRecycleHook(fn) {
  onRecycleHook = typeof fn === "function" ? fn : null;
}

function getRecycleStatus() {
  return {
    poisoned: processPoisoned,
    recycleScheduled,
    recycleAt: recycleAt || null,
    auto: isAutoRecycleEnabled(),
  };
}

function resetForTests() {
  processPoisoned = false;
  recycleScheduled = false;
  recycleAt = 0;
}

module.exports = {
  isProcessPoisoned,
  markProcessPoisoned,
  scheduleRecycle,
  setRecycleHook,
  getRecycleStatus,
  resetForTests,
};
