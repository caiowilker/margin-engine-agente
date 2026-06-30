/**
 * PrinterService — único ponto de impressão do agente.
 * Provider padrão: acbr-posprinter · fallback: native (configurável).
 */
const log = require("./logger").child({ modulo: "printer_service" });
const factory = require("./print/factory");
const { classifyPrintError } = require("./print/printErrors");

let printLock = Promise.resolve();

function withPrintLock(fn, label = "print") {
  const run = printLock.then(() => fn());
  printLock = run.catch(() => {});
  return run;
}

async function withProvider(fn, opts = {}) {
  const primary = factory.getPrintProvider();
  const primaryName = primary.getProviderName();
  try {
    return await fn(primary);
  } catch (err) {
    const cls = classifyPrintError(err);
    const fallbackName = factory.resolveFallbackName();
    if (
      !opts.noFallback &&
      cls.fallbackSuggested &&
      fallbackName &&
      fallbackName !== primaryName
    ) {
      log.warn(
        {
          err: err.message,
          primary: primaryName,
          fallback: fallbackName,
          retryable: cls.retryable,
        },
        "[PrinterService] Fallback de provider",
      );
      const fallback = factory.createProvider(fallbackName);
      return fn(fallback);
    }
    throw err;
  }
}

function wrap(name, fn) {
  return (...args) =>
    withPrintLock(
      () =>
        withProvider(async (provider) => {
          const t0 = Date.now();
          const info = provider.getDriverInfo?.() || {};
          try {
            const result = await provider[name](...args);
            log.info(
              {
                op: name,
                provider: provider.getProviderName(),
                mode: info.mode,
                durationMs: Date.now() - t0,
              },
              "[PrinterService] Impressão OK",
            );
            return result;
          } catch (err) {
            const cls = classifyPrintError(err);
            log.error(
              {
                op: name,
                provider: provider.getProviderName(),
                err: err.message,
                retryable: cls.retryable,
                permanente: cls.permanente,
                durationMs: Date.now() - t0,
              },
              "[PrinterService] Falha na impressão",
            );
            throw err;
          }
        }),
      name,
    );
}

async function testar(force = false) {
  return withProvider((p) => p.testar(force));
}

async function getInfo(force = false) {
  const info = await withProvider((p) => p.getInfo(force), { noFallback: true });
  return {
    ...info,
    provider: factory.getProviderName(),
    requestedProvider: factory.getRequestedProviderName(),
    driver: factory.getDriverInfo(),
    fallback: factory.resolveFallbackName(),
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
  return withProvider((p) => p.detectar());
}

async function imprimirTeste() {
  return withPrintLock(
    () =>
      withProvider(async (provider) => {
        if (typeof provider.imprimirTeste === "function") {
          return provider.imprimirTeste();
        }
        return provider.imprimirCupom({
          numeroVenda: "TESTE",
          emitidoEm: new Date().toISOString(),
          total: 0.01,
          empresa: { nomeFantasia: "TESTE IMPRESSORA" },
          itens: [{ nome: "Item teste", quantidade: 1, precoUnitario: 0.01, total: 0.01 }],
          formaPagamento: "dinheiro",
          origem: "local",
        });
      }),
    "imprimirTeste",
  );
}

async function imprimirSegundaVia(opts = {}) {
  const { montarPayloadSegundaVia } = require("./print/segundaVia");
  const payload = opts.segundaVia ? opts : montarPayloadSegundaVia(opts);
  return withPrintLock(
    () =>
      withProvider(async (provider) => {
        if (typeof provider.imprimirSegundaVia === "function") {
          return provider.imprimirSegundaVia(payload);
        }
        return provider.imprimirCupom(payload);
      }),
    "imprimirSegundaVia",
  );
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
};
