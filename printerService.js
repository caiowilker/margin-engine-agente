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

async function testar(force = false) {
  const factoryMod = factory;
  const p = factoryMod.getPrintProvider();
  return p.testar(force);
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
    const meta = {};
    const payload = args[0];
    if (payload && typeof payload === "object") {
      meta.usuario = payload.operador || payload.usuario;
      meta.caixa = payload.caixa || payload.terminal;
    }
    return submit(name, args, meta);
  };
}

async function imprimirTeste() {
  return submit("imprimirTeste", [], { motivo: "teste_operador" });
}

async function imprimirSegundaVia(opts = {}) {
  return submit("imprimirSegundaVia", [opts], {
    motivo: opts.motivo || "segunda_via",
    documento: opts.chave || opts.numeroVenda,
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
  abrirGaveta: wrap("abrirGaveta"),
  getProviderName: () => factory.getProviderName(),
  getRequestedProviderName: () => factory.getRequestedProviderName(),
  getDriverInfo: () => factory.getDriverInfo(),
  resetPrintProvider: () => factory.resetPrintProvider(),
  printJobService,
};
