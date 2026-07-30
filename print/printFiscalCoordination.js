/**
 * Coordena impressão térmica com emissão fiscal ACBr — evita -10 e fila presa no Windows RAW.
 */
const log = require("../logger").child({ modulo: "print_fiscal_coord" });

function fiscalEmUso() {
  try {
    if (require("../acbr").isAcbrBusy()) return true;
  } catch (_) {}
  try {
    if (require("../fiscal/fiscalEmissionLock").isEmissionInProgress()) return true;
  } catch (_) {}
  return false;
}

/**
 * Aguarda fiscal liberar a sessão.
 * Default curto: impressão térmica não pode travar 120s — PDV precisa ser instantâneo.
 */
async function aguardarFiscalLivre(maxMs) {
  const limite = Number.isFinite(maxMs)
    ? maxMs
    : parseInt(process.env.PRINT_FISCAL_WAIT_MS || "5000", 10);
  const started = Date.now();
  const deadline = started + Math.max(0, limite);
  while (Date.now() < deadline) {
    if (!fiscalEmUso()) {
      return { aguardouMs: Date.now() - started, timeout: false };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  log.warn(
    { aguardouMs: Date.now() - started, maxMs: limite },
    "[PrintFiscalCoord] Timeout aguardando fiscal — prosseguindo com impressão",
  );
  return { aguardouMs: Date.now() - started, timeout: true };
}

function precisaPortaAcbrNativa() {
  try {
    const factory = require("./factory");
    if (factory.getProviderName() !== "acbr-posprinter") return false;
    return require("./acbrPosPrinterRuntime").canLoadNativeLib();
  } catch (_) {
    return false;
  }
}

async function prepararImpressaoAposFiscal() {
  // Native ESC/POS não compartilha sessão FFI — espera mínima só se fiscal estiver ativo
  const acbrNativo = precisaPortaAcbrNativa();
  const waitMs = acbrNativo
    ? parseInt(process.env.PRINT_FISCAL_WAIT_MS || "5000", 10)
    : parseInt(process.env.PRINT_FISCAL_WAIT_NATIVE_MS || "1500", 10);
  const wait = fiscalEmUso()
    ? await aguardarFiscalLivre(waitMs)
    : { aguardouMs: 0, timeout: false };

  if (process.platform === "win32" && acbrNativo) {
    try {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
      const cooldownMs = parseInt(process.env.PRINT_POS_COOLDOWN_MS || "200", 10);
      if (cooldownMs > 0) {
        await new Promise((r) => setTimeout(r, cooldownMs));
      }
    } catch (_) {}
  }
  if (acbrNativo) {
    try {
      await require("./printerBootstrap").garantirPortaImpressao({ skipDetect: true });
    } catch (err) {
      log.warn({ err: err.message }, "[PrintFiscalCoord] Porta inválida antes da impressão");
      throw err;
    }
  }
  return wait;
}

module.exports = { fiscalEmUso, aguardarFiscalLivre, prepararImpressaoAposFiscal };
