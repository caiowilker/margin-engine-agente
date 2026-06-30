// Watchdog ACBr — health check e pausa de fila fiscal
const fiscalDriver = require("./fiscalDriver");
const filaFiscal = require("./filaFiscal");

let timer = null;
let falhasConsecutivas = 0;
let degraded = false;
const MAX_FALHAS = 3;
const INTERVAL_MS = parseInt(process.env.ACBR_WATCHDOG_MS || "30000", 10);

function statusWatchdog() {
  return { degraded, falhasConsecutivas, intervalMs: INTERVAL_MS };
}

async function tick(restartAcbrFn) {
  const filaFiscal = require("./filaFiscal");
  if (fiscalDriver.isAcbrBusy?.() || filaFiscal.estaProcessando?.()) {
    return;
  }
  try {
    const ok = await fiscalDriver.testar();
    if (ok) {
      if (degraded) {
        console.log("[Watchdog ACBr] Serviço restaurado — retomando fila fiscal");
        filaFiscal.retomarFila();
      }
      falhasConsecutivas = 0;
      degraded = false;
      return;
    }
    throw new Error("NFE.StatusServico falhou");
  } catch (err) {
    falhasConsecutivas++;
    if (falhasConsecutivas >= MAX_FALHAS && !degraded) {
      degraded = true;
      filaFiscal.pausarFila();
      console.warn(
        `[Watchdog ACBr] DEGRADED após ${falhasConsecutivas} falhas — fila pausada`,
      );
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

function iniciar(restartAcbrFn) {
  if (timer) return;
  timer = setInterval(() => tick(restartAcbrFn), INTERVAL_MS);
  tick(restartAcbrFn);
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { iniciar, parar, statusWatchdog, tick };
