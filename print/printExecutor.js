/**
 * Execução física de impressão — chamada apenas pelo PrintJobService.
 */
const log = require("../logger").child({ modulo: "print_executor" });
const factory = require("./factory");
const { classifyPrintError } = require("./printErrors");

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
        { err: err.message, primary: primaryName, fallback: fallbackName },
        "[PrintExecutor] Fallback de provider",
      );
      const fallback = factory.createProvider(fallbackName);
      return fn(fallback);
    }
    throw err;
  }
}

function driverSnapshot(provider) {
  const info = provider.getDriverInfo?.() || {};
  const cfg = require("./printerLocalConfig").ler();
  return {
    provider: provider.getProviderName(),
    driver: info.label || info.provider || provider.getProviderName(),
    porta: cfg.porta || process.env.PRINTER_PORTA || null,
    modelo: cfg.modelo || process.env.PRINTER_MODEL || null,
  };
}

async function executarProviderOp(provider, op, args, timeoutMs) {
  const payload = args?.[0];
  const snap = () => driverSnapshot(provider);
  const t0 = Date.now();

  const invoke = async () => {
    if (op === "imprimirSegundaVia") {
      const { montarPayloadSegundaVia } = require("./segundaVia");
      const payloadSv = payload?.segundaVia ? payload : montarPayloadSegundaVia(payload || {});
      if (typeof provider.imprimirSegundaVia === "function") {
        return provider.imprimirSegundaVia(payloadSv);
      }
      return provider.imprimirCupom(payloadSv);
    }
    if (typeof provider[op] !== "function") {
      throw new Error(`Operação de impressão não suportada: ${op}`);
    }
    return provider[op](...(args || []));
  };

  let timer;
  const timeoutPromise =
    timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timeout de impressão (${timeoutMs}ms)`)),
            timeoutMs,
          );
        })
      : null;

  try {
    const result = timeoutPromise
      ? await Promise.race([invoke(), timeoutPromise])
      : await invoke();
    const s = snap();
    return {
      result,
      durationMs: Date.now() - t0,
      bytesEnviados: result?.bytes || result?.lines || null,
      ...s,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executarOp(op, args, timeoutMs) {
  return withProvider((provider) => executarProviderOp(provider, op, args, timeoutMs));
}

module.exports = { executarOp, classifyPrintError };
