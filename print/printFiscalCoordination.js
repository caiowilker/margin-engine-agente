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

async function prepararImpressaoAposFiscal() {
  const wait = await aguardarFiscalLivre();
  if (process.platform !== "win32") return wait;
  try {
    const cfg = require("./printerLocalConfig").ler();
    if (/^RAW:/i.test(String(cfg.porta || ""))) {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
    }
  } catch (_) {}
  return wait;
}

module.exports = { fiscalEmUso, aguardarFiscalLivre, prepararImpressaoAposFiscal };
