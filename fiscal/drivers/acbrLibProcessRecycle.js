/**
 * Reciclagem do processo Node quando koffi/ACBrLib fica irrecuperável (void**).
 *
 * Regras de produção (agente HTTP tem que ficar UP):
 * - Graça de boot: NÃO exit nos primeiros N segundos (ativação do terminal / ME-012).
 * - Rate limit: no máximo N recycles por janela; depois mantém processo vivo em degradado.
 * - Preferir agente online (9100) com fiscal degradado a crash-loop do serviço Windows.
 */
const log = require("../../logger").child({ modulo: "acbr_lib_recycle" });

const PROCESS_STARTED_AT = Date.now();

let processPoisoned = false;
let recycleScheduled = false;
let recycleAt = 0;
let recycleCountWindow = [];
let onRecycleHook = null;

function isAutoRecycleEnabled() {
  return String(process.env.ACBR_LIB_AUTO_RECYCLE || "true").toLowerCase() !== "false";
}

function recycleDelayMs() {
  return parseInt(process.env.ACBR_LIB_RECYCLE_DELAY_MS || "2500", 10);
}

function bootGraceMs() {
  return parseInt(process.env.ACBR_LIB_RECYCLE_BOOT_GRACE_MS || "120000", 10);
}

function maxRecyclesPerHour() {
  return parseInt(process.env.ACBR_LIB_RECYCLE_MAX_PER_HOUR || "3", 10);
}

function isProcessPoisoned() {
  return processPoisoned === true;
}

function inBootGrace() {
  return Date.now() - PROCESS_STARTED_AT < Math.max(0, bootGraceMs());
}

/** Com emissão fiscal ativa, recycle imediato — não segurar processo envenenado 2 min. */
function shouldDeferRecycleForBoot() {
  if (!inBootGrace()) return false;
  try {
    const acbr = require("../../acbr");
    if (acbr.EMISSAO_FISCAL) return false;
  } catch (_) {}
  return true;
}

function pruneRecycleWindow() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  recycleCountWindow = recycleCountWindow.filter((t) => t >= hourAgo);
}

function markProcessPoisoned(reason = "koffi_void") {
  if (!processPoisoned) {
    processPoisoned = true;
    log.error(
      { reason, metric: "acbrlib.process_poisoned" },
      "[ACBrLib] Processo envenenado (koffi) — emissão nativa bloqueada",
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

  if (shouldDeferRecycleForBoot()) {
    log.warn(
      {
        reason,
        bootGraceMs: bootGraceMs(),
        uptimeMs: Date.now() - PROCESS_STARTED_AT,
        metric: "acbrlib.recycle_deferred_boot",
      },
      "[ACBrLib] Recycle adiado — graça de boot (mantém porta 9100 no ar)",
    );
    return false;
  }

  pruneRecycleWindow();
  const max = Math.max(1, maxRecyclesPerHour());
  if (recycleCountWindow.length >= max) {
    log.error(
      {
        reason,
        recyclesLastHour: recycleCountWindow.length,
        max,
        metric: "acbrlib.recycle_rate_limited",
      },
      "[ACBrLib] Recycle bloqueado (rate limit) — agente permanece ONLINE com fiscal degradado. Reinicie o serviço manualmente se necessário.",
    );
    return false;
  }

  if (recycleScheduled) return true;
  recycleScheduled = true;
  const delay = Math.max(500, recycleDelayMs());
  recycleAt = Date.now() + delay;
  recycleCountWindow.push(Date.now());
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
  pruneRecycleWindow();
  return {
    poisoned: processPoisoned,
    recycleScheduled,
    recycleAt: recycleAt || null,
    auto: isAutoRecycleEnabled(),
    bootGrace: shouldDeferRecycleForBoot(),
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    recyclesLastHour: recycleCountWindow.length,
  };
}

function resetForTests() {
  processPoisoned = false;
  recycleScheduled = false;
  recycleAt = 0;
  recycleCountWindow = [];
}

module.exports = {
  isProcessPoisoned,
  markProcessPoisoned,
  scheduleRecycle,
  setRecycleHook,
  getRecycleStatus,
  resetForTests,
  inBootGrace,
};
