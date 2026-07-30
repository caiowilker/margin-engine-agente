/**
 * Execução física de impressão — chamada apenas pelo PrintJobService.
 *
 * Contrato de timeout (anti-dupla-impressão):
 * - Não abandona invoke em andamento para iniciar fallback/retry.
 * - Se o deadline estoura, AGUARDA o invoke terminar (drain).
 * - Se o invoke completar com sucesso após o deadline → aceita (late ok).
 * - Só então classifica erro / libera sessão ACBr / permite fallback.
 */
const log = require("../logger").child({ modulo: "print_executor" });
const factory = require("./factory");
const { classifyPrintError } = require("./printErrors");
const { prepararImpressaoAposFiscal } = require("./printFiscalCoordination");

async function liberarSessaoPosAposFalha() {
  try {
    await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
  } catch (_) {}
}

async function withProvider(fn, opts = {}) {
  const primary = factory.getPrintProvider();
  const primaryName = primary.getProviderName();
  try {
    return await fn(primary);
  } catch (err) {
    const cls = classifyPrintError(err);
    const fallbackName = factory.resolveFallbackName();
    // Invoke já terminou (drain) — seguro liberar sessão antes do fallback
    await liberarSessaoPosAposFalha();
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

/**
 * Executa op no provider com deadline cooperativo.
 * Nunca inicia segundo envio físico enquanto o primeiro ainda corre.
 */
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

  const invokePromise = invoke();

  if (!(timeoutMs > 0)) {
    const result = await invokePromise;
    return {
      result,
      durationMs: Date.now() - t0,
      bytesEnviados: result?.bytes || result?.lines || null,
      ...snap(),
    };
  }

  let timer;
  const deadlineHit = await new Promise((resolve) => {
    let settled = false;
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    }, timeoutMs);
    invokePromise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      },
    );
  });

  if (!deadlineHit) {
    const result = await invokePromise;
    return {
      result,
      durationMs: Date.now() - t0,
      bytesEnviados: result?.bytes || result?.lines || null,
      ...snap(),
    };
  }

  // Deadline estourou — NÃO dispara fallback. Drena o invoke para liberar lock/porta.
  log.warn(
    { op, timeoutMs, provider: provider.getProviderName() },
    "[PrintExecutor] Deadline — aguardando conclusão do envio em andamento (anti-dupla)",
  );
  try {
    const result = await invokePromise;
    const durationMs = Date.now() - t0;
    log.info(
      { op, durationMs, late: true },
      "[PrintExecutor] Envio concluiu após deadline — aceito sem reimpressão",
    );
    return {
      result,
      durationMs,
      late: true,
      bytesEnviados: result?.bytes || result?.lines || null,
      ...snap(),
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const base = String(err?.message || err || "falha");
    const e = new Error(`Timeout de impressão (${timeoutMs}ms): ${base}`);
    e.cause = err;
    e.acbrRet = err?.acbrRet;
    e.code = err?.code;
    e.printTimedOut = true;
    e.durationMs = durationMs;
    throw e;
  }
}

async function executarOp(op, args, timeoutMs) {
  const wait = await prepararImpressaoAposFiscal();
  try {
    const exec = await withProvider((provider) =>
      executarProviderOp(provider, op, args, timeoutMs),
    );
    if (wait?.aguardouMs > 0) {
      exec.waitFiscalMs = wait.aguardouMs;
      log.info(
        { op, waitFiscalMs: wait.aguardouMs, durationMs: exec.durationMs },
        "[PrintExecutor] Impressão após espera fiscal",
      );
    }
    return exec;
  } catch (err) {
    const msg = String(err?.message || "");
    const portaOuAcbr = err?.acbrRet === -10 || /porta|PRINTER_PORTA_INDEFINIDA/i.test(msg);
    if (!portaOuAcbr) throw err;
    log.warn({ op, err: msg }, "[PrintExecutor] Falha de porta — re-detectando impressora");
    try {
      await liberarSessaoPosAposFalha();
      require("./factory").resetPrintProvider();
      await require("./printerBootstrap").garantirPortaImpressao({ force: true });
      return await withProvider(
        (provider) => executarProviderOp(provider, op, args, timeoutMs),
        { noFallback: false },
      );
    } catch (retryErr) {
      throw retryErr;
    }
  }
}

module.exports = { executarOp, classifyPrintError, executarProviderOp };
