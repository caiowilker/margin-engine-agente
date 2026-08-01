// Watchdog ACBr — health check e pausa de fila fiscal
const fiscalDriver = require("./fiscalDriver");
const filaFiscal = require("./filaFiscal");

let timer = null;
let falhasConsecutivas = 0;
let degraded = false;
const MAX_FALHAS = parseInt(process.env.ACBR_WATCHDOG_MAX_FALHAS || "5", 10);
const INTERVAL_MS = parseInt(process.env.ACBR_WATCHDOG_MS || "30000", 10);

function statusWatchdog() {
  return { degraded, falhasConsecutivas, intervalMs: INTERVAL_MS };
}

/** Limpa estado degradado (ex.: operador encerrou contingência manualmente). */
function resetDegraded() {
  degraded = false;
  falhasConsecutivas = 0;
}

function isDegraded() {
  return degraded === true;
}

async function tick(restartAcbrFn, hooks = {}) {
  const filaFiscal = require("./filaFiscal");
  if (fiscalDriver.isAcbrBusy?.() || filaFiscal.estaProcessando?.()) {
    return;
  }
  // Memória online recente: não martela StatusServico (DLL/SEFAZ).
  try {
    const det = fiscalDriver.obterStatusDetalhe?.(false);
    if (det?.estado === "online" && det.atualizadoEm) {
      const age = Date.now() - new Date(det.atualizadoEm).getTime();
      if (Number.isFinite(age) && age >= 0 && age < 45000) {
        falhasConsecutivas = 0;
        return;
      }
    }
  } catch (_) {}
  try {
    const ok = await fiscalDriver.testar();
    if (ok) {
      if (degraded) {
        console.log("[Watchdog ACBr] Serviço restaurado — retomando fila fiscal");
        filaFiscal.retomarFila();
        if (typeof hooks.onRestored === "function") {
          hooks.onRestored().catch((e) =>
            console.warn("[Watchdog ACBr] onRestored:", e.message),
          );
        }
      }
      falhasConsecutivas = 0;
      degraded = false;
      return;
    }
    // Memória degradada (koffi) sem throw — não conta para EPEC.
    try {
      const det = fiscalDriver.obterStatusDetalhe?.(false);
      if (det?.estado === "degradado") {
        console.warn(
          "[Watchdog ACBr] Motor degradado (koffi) — sem contingência",
        );
        return;
      }
    } catch (_) {}
    throw new Error("NFE.StatusServico falhou");
  } catch (err) {
    const msg = String(err?.message || err || "");
    let softKoffi = /void \*\*|unexpected external|invalid handle|session disposed/i.test(
      msg,
    );
    if (!softKoffi) {
      try {
        softKoffi = require("./fiscal/drivers/acbrLibSession").recentlyHadKoffiDead();
      } catch (_) {}
    }
    if (softKoffi) {
      console.warn(
        "[Watchdog ACBr] Sessão nativa inválida — reset suave (sem contingência)",
      );
      try {
        if (typeof fiscalDriver.invalidateNativeSession === "function") {
          await fiscalDriver.invalidateNativeSession("watchdog_soft");
        }
      } catch (_) {}
      return;
    }
    falhasConsecutivas++;
    if (falhasConsecutivas >= MAX_FALHAS && !degraded) {
      // Última guarda: nunca abrir EPEC por glitch koffi recente / soft-dead.
      try {
        const session = require("./fiscal/drivers/acbrLibSession");
        if (session.recentlyHadKoffiDead() || session.isSoftDead()) {
          console.warn(
            "[Watchdog ACBr] Falhas consecutivas ignoradas — koffi/soft-dead (sem contingência)",
          );
          falhasConsecutivas = 0;
          return;
        }
      } catch (_) {}
      degraded = true;
      filaFiscal.pausarFila();
      console.warn(
        `[Watchdog ACBr] DEGRADED após ${falhasConsecutivas} falhas — fila pausada`,
      );
      if (typeof hooks.onDegraded === "function") {
        hooks.onDegraded(err).catch((e) =>
          console.warn("[Watchdog ACBr] onDegraded:", e.message),
        );
      }
      if (
        restartAcbrFn &&
        (process.env.ACBR_AUTO_RESTART || "false").toLowerCase() === "true"
      ) {
        try {
          await restartAcbrFn();
        } catch (e) {
          console.error("[Watchdog ACBr] Falha ao reiniciar:", e.message);
        }
      }
    }
  }
}

function iniciar(restartAcbrFn, hooks = {}) {
  if (timer) return;
  const run = () => tick(restartAcbrFn, hooks);
  timer = setInterval(run, INTERVAL_MS);
  run();
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { iniciar, parar, statusWatchdog, tick, resetDegraded, isDegraded };
