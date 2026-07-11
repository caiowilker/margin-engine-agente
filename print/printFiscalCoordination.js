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

async function aguardarFiscalLivre(maxMs = 120000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!fiscalEmUso()) return { aguardouMs: 0 };
    await new Promise((r) => setTimeout(r, 300));
  }
  log.warn("[PrintFiscalCoord] Timeout aguardando fiscal — prosseguindo com impressão");
  return { aguardouMs: maxMs, timeout: true };
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
  const wait = await aguardarFiscalLivre();
  const acbrNativo = precisaPortaAcbrNativa();
  if (process.platform === "win32" && acbrNativo) {
    try {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
      const cooldownMs = parseInt(process.env.PRINT_POS_COOLDOWN_MS || "400", 10);
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
