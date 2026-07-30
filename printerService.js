/**
 * PrinterService — único ponto de impressão do agente (Frente 13).
 * Toda operação passa pelo PrintJobService (fila, retry, auditoria).
 */
const log = require("./logger").child({ modulo: "printer_service" });
const factory = require("./print/factory");
const printJobService = require("./print/printJobService");

async function submit(op, args, opts = {}) {
  return printJobService.submitPrint(op, args, opts);
}

// Cache de resultado de probe para evitar N conexões simultâneas em polls concorrentes.
const _probeCache = { result: null, at: 0 };
const PROBE_CACHE_TTL_MS = parseInt(process.env.PRINTER_PROBE_TTL_MS || "5000", 10);

/**
 * Testa conectividade da impressora.
 *
 * Fonte de verdade unificada: se houve impressão bem-sucedida recentemente
 * (via printJobService — o mesmo serviço que efetivamente imprime), retorna
 * ok sem disparar um probe independente.  Só executa o probe ao vivo quando
 * não há registro recente de impressão, e mesmo assim limita a frequência com
 * um cache de PROBE_CACHE_TTL_MS (padrão 5 s) para não disparar N conexões
 * simultâneas quando múltiplos clientes fazem poll ao mesmo tempo.
 */
async function testar(force = false) {
  if (!force && printJobService.impressaoRecenteOk()) {
    _probeCache.result = true;
    _probeCache.at = Date.now();
    return true;
  }
  if (!force && _probeCache.result !== null && Date.now() - _probeCache.at < PROBE_CACHE_TTL_MS) {
    return _probeCache.result;
  }
  const result = await factory.getPrintProvider().testar(force).catch(() => false);
  _probeCache.result = result;
  _probeCache.at = Date.now();
  return result;
}

/** Invalida o cache de probe — chamado quando a config da impressora muda. */
function invalidateProbeCache() {
  _probeCache.result = null;
  _probeCache.at = 0;
}

async function getInfo(force = false) {
  const info = await factory.getPrintProvider().getInfo(force);
  const obs = printJobService.observabilidade();
  return {
    ...info,
    provider: factory.getProviderName(),
    requestedProvider: factory.getRequestedProviderName(),
    driver: factory.getDriverInfo(),
    fallback: factory.resolveFallbackName(),
    printJobs: obs.fila,
    ultimaImpressaoJob: obs.ultimaImpressao,
  };
}

function listar() {
  const p = factory.getPrintProvider();
  return {
    ...p.listar(),
    provider: factory.getProviderName(),
    requestedProvider: factory.getRequestedProviderName(),
    driver: factory.getDriverInfo(),
  };
}

async function detectar() {
  return factory.getPrintProvider().detectar();
}

function wrap(name) {
  return (...args) => {
    const meta = { async: true };
    const payload = args[0];
    if (payload && typeof payload === "object") {
      meta.usuario = payload.operador || payload.usuario;
      meta.caixa = payload.caixa || payload.terminal;
    }
    // Resposta imediata (fila) — PDV não pode esperar WritePrinter/spooler
    return submit(name, args, meta);
  };
}

async function imprimirTeste() {
  return submit("imprimirTeste", [], { motivo: "teste_operador", async: true });
}

async function imprimirSegundaVia(opts = {}) {
  return submit("imprimirSegundaVia", [opts], {
    motivo: opts.motivo || "segunda_via",
    documento: opts.chave || opts.numeroVenda,
    async: true,
  });
}

module.exports = {
  testar,
  getInfo,
  listar,
  detectar,
  imprimirTeste,
  imprimirSegundaVia,
  imprimirCupom: wrap("imprimirCupom"),
  imprimirAbertura: wrap("imprimirAbertura"),
  imprimirFechamento: wrap("imprimirFechamento"),
  imprimirMovimentoCaixa: wrap("imprimirMovimentoCaixa"),
  imprimirPedido: wrap("imprimirPedido"),
  abrirGaveta: wrap("abrirGaveta"),
  getProviderName: () => factory.getProviderName(),
  getRequestedProviderName: () => factory.getRequestedProviderName(),
  getDriverInfo: () => factory.getDriverInfo(),
  resetPrintProvider: () => {
    invalidateProbeCache();
    factory.resetPrintProvider();
  },
  invalidateProbeCache,
  printJobService,
};
