/**
 * Coordena impressão térmica com emissão fiscal ACBr — evita -10 e fila presa no Windows RAW.
 *
 * Regra de ouro: impressão térmica NÃO pode invalidar/reativar a sessão PosPrinter
 * a cada cupom. POS_Ativar em porta RAW: (spooler) trava minutos se chamado em loop
 * — sintoma: "enviado" na hora, papel só depois, agente some e volta.
 *
 * Fast-path (não fiscal / ESC/POS nativo): zero ACBr — só espera curta se fiscal
 * estiver usando o hardware USB no mesmo momento.
 */
const log = require("../logger").child({ modulo: "print_fiscal_coord" });

let _ultimaVezFiscalOcupadoEm = 0;

const OPS_FAST_NATIVE = new Set([
  "imprimirTeste",
  "abrirGaveta",
  "imprimirAbertura",
  "imprimirFechamento",
  "imprimirMovimentoCaixa",
  "imprimirPedido",
]);

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
 * Com PHYSICAL_USB_TOPOLOGY=shared: NÃO prosseguir no timeout — o physicalLock
 * serializa de verdade; aqui esperamos até liberar (ou max alto).
 */
async function aguardarFiscalLivre(maxMs) {
  const shared = (() => {
    try {
      return require("../runtime/physicalResourceMap").isSharedUsbTopology();
    } catch (_) {
      return false;
    }
  })();
  const limite = Number.isFinite(maxMs)
    ? maxMs
    : shared
      ? parseInt(process.env.PRINT_FISCAL_WAIT_SHARED_MS || "30000", 10)
      : parseInt(process.env.PRINT_FISCAL_WAIT_MS || "2000", 10);
  const started = Date.now();
  const deadline = started + Math.max(0, limite);
  while (Date.now() < deadline) {
    if (!fiscalEmUso()) {
      return { aguardouMs: Date.now() - started, timeout: false };
    }
    _ultimaVezFiscalOcupadoEm = Date.now();
    await new Promise((r) => setTimeout(r, 40));
  }
  if (shared) {
    // Ainda ocupado: não "pula" — quem imprime adquire physicalLock (usb-shared) e espera.
    log.warn(
      { aguardouMs: Date.now() - started, maxMs: limite, topology: "shared" },
      "[PrintFiscalCoord] Fiscal ainda ativo (shared USB) — impressão aguardará physicalLock",
    );
    return { aguardouMs: Date.now() - started, timeout: true, sharedBlocked: true };
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

function fiscalAcabouDeUsar(janelaMs) {
  const janela = Number.isFinite(janelaMs)
    ? janelaMs
    : parseInt(process.env.PRINT_POS_INVALIDATE_AFTER_FISCAL_MS || "3000", 10);
  if (fiscalEmUso()) return true;
  return _ultimaVezFiscalOcupadoEm > 0 && Date.now() - _ultimaVezFiscalOcupadoEm < janela;
}

function isFastNativePath(opts = {}) {
  if (opts.fastNative === true) return true;
  if (opts.fastNative === false) return false;
  // Padrão produção: ACBr — native só com PRINT_FAST_NATIVE=true/always
  const flag = String(process.env.PRINT_FAST_NATIVE || "false").toLowerCase();
  if (flag === "false" || flag === "0") return false;
  if (opts.op && OPS_FAST_NATIVE.has(opts.op)) return true;
  const payload = opts.payload;
  if (payload && typeof payload === "object") {
    try {
      return require("./drivers/acbrPosPrinterProvider").preferNativeEscPos(payload);
    } catch (_) {
      if (payload.naoFiscal || payload.cupomSemFiscal) return true;
    }
  }
  return false;
}

/**
 * Prepara impressão sem martelar Ativar/Desativar.
 * Fast-path: não toca em PosPrinter.
 * ACBr tags (fiscal): invalida só após fiscal; garante porta.
 */
async function prepararImpressaoAposFiscal(opts = {}) {
  if (fiscalEmUso()) {
    _ultimaVezFiscalOcupadoEm = Date.now();
  }

  const fast = isFastNativePath(opts);
  if (fast) {
    if (!fiscalEmUso()) {
      return { aguardouMs: 0, timeout: false, fastNative: true };
    }
    const waitMs = parseInt(process.env.PRINT_FISCAL_WAIT_NATIVE_MS || "800", 10);
    const wait = await aguardarFiscalLivre(waitMs);
    return { ...wait, fastNative: true };
  }

  const acbrNativo = precisaPortaAcbrNativa();
  const waitMs = acbrNativo
    ? parseInt(process.env.PRINT_FISCAL_WAIT_MS || "2000", 10)
    : parseInt(process.env.PRINT_FISCAL_WAIT_NATIVE_MS || "1000", 10);

  const wait = fiscalEmUso()
    ? await aguardarFiscalLivre(waitMs)
    : { aguardouMs: 0, timeout: false };

  const always = process.env.PRINT_POS_ALWAYS_INVALIDATE === "true";
  const deveInvalidar =
    process.platform === "win32" && acbrNativo && (always || fiscalAcabouDeUsar());

  if (deveInvalidar) {
    try {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
      const cooldownMs = parseInt(process.env.PRINT_POS_COOLDOWN_MS || "100", 10);
      if (cooldownMs > 0) {
        await new Promise((r) => setTimeout(r, cooldownMs));
      }
      log.info(
        { aguardouMs: wait.aguardouMs, always },
        "[PrintFiscalCoord] Sessão PosPrinter invalidada pós-fiscal",
      );
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
  return { ...wait, fastNative: false };
}

module.exports = {
  fiscalEmUso,
  aguardarFiscalLivre,
  prepararImpressaoAposFiscal,
  fiscalAcabouDeUsar,
  isFastNativePath,
};
