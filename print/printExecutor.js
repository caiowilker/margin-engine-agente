/**
 * Execução física de impressão — chamada apenas pelo PrintJobService.
 *
 * Contrato de timeout (anti-dupla-impressão + anti-hang):
 * - Não inicia segundo envio físico enquanto o primeiro ainda corre.
 * - Se o soft-deadline estoura, aguarda o invoke por mais HARD_DRAIN_MS.
 * - Se ainda não terminou → falha (não espera minutos). Sessão ACBr invalidada.
 * - Late success dentro do drain → aceita (sem reimpressão).
 */
const log = require("../logger").child({ modulo: "print_executor" });
const factory = require("./factory");
const { classifyPrintError } = require("./printErrors");
const { prepararImpressaoAposFiscal } = require("./printFiscalCoordination");

/** Invokes abandonados pelo hard-drain ainda rodando no worker — não retentar/reclaim. */
let abandonedPhysicalSends = 0;

function physicalSendAbandonedInFlight() {
  return abandonedPhysicalSends > 0;
}

function trackAbandonedInvoke(invokePromise) {
  abandonedPhysicalSends += 1;
  const abandonedAt = Date.now();
  Promise.resolve(invokePromise)
    .then(() => {
      const lateMs = Date.now() - abandonedAt;
      log.warn(
        {
          metric: "print.late_abandoned",
          late: true,
          lateMs,
          note:
            "Envio físico concluiu após hard drain — tipicamente spooler/driver USB drenando; taskkill do wrapper PowerShell não cancela job já no kernel",
        },
        "[PrintExecutor] late_abandoned_ok — envio concluiu após hard drain; job já finalizado (sem reimpressão)",
      );
    })
    .catch((err) => {
      log.debug(
        {
          err: err?.message,
          metric: "print.late_abandoned",
          lateMs: Date.now() - abandonedAt,
        },
        "[PrintExecutor] late_abandoned_fail",
      );
    })
    .finally(() => {
      abandonedPhysicalSends = Math.max(0, abandonedPhysicalSends - 1);
    });
}

async function liberarSessaoPosAposFalha() {
  try {
    await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
  } catch (_) {}
}

async function withProvider(fn, opts = {}) {
  const payload = opts.payload;
  const op = opts.op;
  let primary = factory.getPrintProvider();
  let primaryName = primary.getProviderName();

  // Por job: gaveta / circuito / RAW comercial / preferNative → native direto (sem ACBr).
  // Fiscal/DANFE com chave permanece no ACBr mesmo com circuito aberto.
  if (!opts.forceAcbr && primaryName === "acbr-posprinter") {
    try {
      const runtime = require("./acbrPosPrinterRuntime");
      const acbrProv = require("./drivers/acbrPosPrinterProvider");
      const fiscal = payload && acbrProv.isFiscalPayload?.(payload);
      const wantNative =
        op === "abrirGaveta" ||
        (!fiscal &&
          (runtime.isAcbrPosCircuitOpen?.() ||
            acbrProv.portaEhRawWindows?.() ||
            (payload && acbrProv.preferNativeEscPos?.(payload))));
      if (wantNative) {
        const fbName = factory.resolveFallbackName() || "native";
        if (fbName !== primaryName) {
          primary = factory.createProvider(fbName);
          primaryName = primary.getProviderName();
          log.info(
            {
              effective: primaryName,
              metric: "print.provider_effective",
              reason:
                op === "abrirGaveta"
                  ? "gaveta"
                  : runtime.isAcbrPosCircuitOpen?.()
                    ? "circuit"
                    : acbrProv.portaEhRawWindows?.()
                      ? "raw_windows"
                      : "prefer_native",
            },
            "[PrintExecutor] Native direto (comercial)",
          );
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  try {
    return await fn(primary);
  } catch (err) {
    const cls = classifyPrintError(err);
    const fallbackName = factory.resolveFallbackName();
    await liberarSessaoPosAposFalha();
    try {
      const runtime = require("./acbrPosPrinterRuntime");
      if (runtime.shouldOpenCircuitFromError?.(err)) {
        if (runtime.openAcbrPosCircuit?.(err.message)) {
          try {
            factory.resetPrintProvider();
          } catch (_) {}
        }
      }
    } catch (_) {
      /* ignore */
    }

    // Hard drain / timeout após envio físico: NÃO fallback (anti-dupla).
    // Exceção: falha PRÉ-impressão ACBr (ConfigGravar/Ativar / phase≠imprimir).
    // RAW_PRINT_TIMEOUT = WritePrinter já iniciado — nunca segundo envio.
    if (err?.code === "PRINT_HARD_DRAIN" || err?.code === "RAW_PRINT_TIMEOUT" || err?.printTimedOut === true) {
      const msgLow = String(err?.message || "").toLowerCase();
      let phase = err?.acbrPhase;
      try {
        phase = phase || require("./acbrPosPrinterRuntime").getAcbrPrintPhase?.();
      } catch (_) {}
      const phasePre =
        phase === "config" || phase === "ativar" || phase === "init" || phase === "idle";
      const prePrintOnly =
        err?.code !== "RAW_PRINT_TIMEOUT" &&
        (err?.fallbackNative === true ||
          ((phasePre ||
            /pos_configgravar|configgravarvalor|pos_ativar|pos_inicializar/i.test(msgLow) ||
            err?.acbrRet === -10) &&
            phase !== "imprimir" &&
            !/pos_imprimir|imprimir\b/i.test(msgLow)));
      if (!prePrintOnly) {
        log.warn(
          {
            err: err.message,
            primary: primaryName,
            metric: "print.no_fallback_after_drain",
            acbrPhase: phase || null,
          },
          "[PrintExecutor] Hard drain — sem segundo envio físico neste job (anti-dupla)",
        );
        throw err;
      }
      log.warn(
        {
          err: err.message,
          primary: primaryName,
          metric: "print.fallback_after_preprint_timeout",
          acbrPhase: phase || null,
        },
        "[PrintExecutor] Timeout pré-impressão ACBr — fallback native (sem risco de dupla)",
      );
      err.printTimedOut = false;
      err.fallbackNative = true;
      err.code = err.acbrRet != null ? "ACBR_POS_ERROR" : err.code;
    }

    if (
      !opts.noFallback &&
      (cls.fallbackSuggested || err?.fallbackNative) &&
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

/** Drain curto: PDV comercial não espera 8s após soft timeout. */
function hardDrainMs(timeoutMs) {
  const soft = timeoutMs || 4000;
  return parseInt(
    process.env.PRINT_HARD_DRAIN_MS ||
      String(Math.min(2000, Math.max(1000, Math.floor(soft / 2)))),
    10,
  );
}

/**
 * Executa op no provider com deadline cooperativo + hard drain.
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
        const lagMs = Date.now() - t0 - timeoutMs;
        if (lagMs > 2000) {
          log.error(
            {
              op,
              timeoutMs,
              lagMs,
              wallMs: Date.now() - t0,
              metric: "print.event_loop_lag",
              note:
                "Soft deadline atrasou — event loop bloqueado (AV/TEMP sync/FFI). Cupom fica lento nesta máquina.",
            },
            "[PrintExecutor] Event loop lag — soft timeout atrasado",
          );
        }
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

  const drainMs = hardDrainMs(timeoutMs);
  const wallAtDeadline = Date.now() - t0;
  log.warn(
    {
      op,
      timeoutMs,
      drainMs,
      wallAtDeadline,
      provider: provider.getProviderName(),
    },
    "[PrintExecutor] Deadline — drain curto (anti-hang); sem segundo envio",
  );

  let drainTimer;
  try {
    const result = await Promise.race([
      invokePromise,
      new Promise((_, reject) => {
        drainTimer = setTimeout(() => {
          const e = new Error(
            `Timeout de impressão (${timeoutMs}+${drainMs}ms) — envio não concluiu`,
          );
          e.printTimedOut = true;
          e.code = "PRINT_HARD_DRAIN";
          reject(e);
        }, drainMs);
      }),
    ]);
    const durationMs = Date.now() - t0;
    // Soft+drain saudável ≈ 6s. Se wall >> isso, o soft timer só disparou tarde
    // (event loop lag) — ainda aceita (papel pode ter saído) mas marca métrica.
    const expectedMax = timeoutMs + drainMs + 1500;
    if (durationMs > expectedMax) {
      log.warn(
        {
          op,
          durationMs,
          expectedMax,
          lagMs: durationMs - timeoutMs,
          metric: "print.drain_accepted_after_lag",
          late: true,
        },
        "[PrintExecutor] Envio no drain após lag extremo — investigue AV/TEMP nesta máquina",
      );
    } else {
      log.info(
        { op, durationMs, late: true },
        "[PrintExecutor] Envio concluiu no drain — aceito sem reimpressão",
      );
    }
    return {
      result,
      durationMs,
      late: true,
      bytesEnviados: result?.bytes || result?.lines || null,
      ...snap(),
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    // Invoke ainda pode estar vivo no FFI/PowerShell — rastreia até settled
    trackAbandonedInvoke(invokePromise);
    await liberarSessaoPosAposFalha();
    if (err?.printTimedOut || err?.code === "PRINT_HARD_DRAIN") {
      err.durationMs = durationMs;
      throw err;
    }
    const e = new Error(`Timeout de impressão (${timeoutMs}ms): ${err?.message || err}`);
    e.cause = err;
    e.acbrRet = err?.acbrRet;
    e.code = err?.code || "PRINT_TIMEOUT";
    e.printTimedOut = true;
    e.durationMs = durationMs;
    throw e;
  } finally {
    clearTimeout(drainTimer);
  }
}

async function executarOp(op, args, timeoutMs) {
  const wait = await prepararImpressaoAposFiscal({ op, payload: args?.[0] });
  try {
    const exec = await withProvider(
      (provider) => executarProviderOp(provider, op, args, timeoutMs),
      { payload: args?.[0], op },
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
    // Timeout / envio abandonado: NÃO re-detectar nem segundo físico
    if (err?.printTimedOut || physicalSendAbandonedInFlight()) throw err;
    const msg = String(err?.message || "");
    const portaOuAcbr = err?.acbrRet === -10 || /porta|PRINTER_PORTA_INDEFINIDA/i.test(msg);
    if (!portaOuAcbr) throw err;
    // Só re-tenta se Ativar/porta falhou ANTES de enviar (não após Imprimir)
    if (/pos_imprimir|imprimirTags/i.test(msg)) throw err;
    log.warn({ op, err: msg }, "[PrintExecutor] Falha de porta — re-detectando impressora");
    try {
      await liberarSessaoPosAposFalha();
      require("./factory").resetPrintProvider();
      await require("./printerBootstrap").garantirPortaImpressao({ force: true });
      return await withProvider(
        (provider) => executarProviderOp(provider, op, args, timeoutMs),
        { noFallback: true },
      );
    } catch (retryErr) {
      throw retryErr;
    }
  }
}

module.exports = {
  executarOp,
  classifyPrintError,
  executarProviderOp,
  hardDrainMs,
  physicalSendAbandonedInFlight,
};
