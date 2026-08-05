/**
 * Diagnóstico completo de impressão — checklist operacional F13.
 */
const factory = require("./factory");
const printerLogo = require("./printerLogo");
const printJobService = require("./printJobService");

function coletarDiagnosticoImpressaoSync(deps = {}) {
  const checks = [];
  const push = (id, ok, detalhe, extra = {}) => {
    checks.push({ id, ok: ok === null ? null : !!ok, detalhe: detalhe || null, ...extra });
  };

  let provider = null;
  let info = deps.impressoraInfo || null;
  try {
    provider = factory.getPrintProvider();
    push("driver_carregado", !!provider, provider?.getProviderName?.() || "provider");
  } catch (err) {
    push("driver_carregado", false, err.message);
  }

  push(
    "impressora_encontrada",
    deps.impressoraOk === true || info?.ok || info?.conectada,
    info?.impressora?.nome || info?.detectada || null,
  );
  push("porta_configurada", !!(info?.porta || info?.acbrPorta), info?.porta || info?.acbrPorta || null);

  const driverInfo = factory.getDriverInfo?.() || {};
  push("provider_ativo", !!driverInfo.provider, driverInfo.label || driverInfo.provider);
  push("acbr_modo", driverInfo.mode !== "unconfigured", driverInfo.mode || "unconfigured");

  try {
    const { checkPosprinterDeps } = require("../scripts/check-posprinter-deps");
    const depsReport = checkPosprinterDeps();
    push(
      "acbr_deps",
      depsReport.ok || process.platform !== "win32",
      process.platform !== "win32"
        ? "n/a (não Windows)"
        : depsReport.ok
          ? `ok (${depsReport.present?.length || 0} arquivos)`
          : `faltando: ${(depsReport.missing || []).slice(0, 5).join(", ")}`,
    );
  } catch (err) {
    push("acbr_deps", null, err.message);
  }

  try {
    const porta = info?.porta || info?.acbrPorta || driverInfo?.iniPath;
    const cfgPorta = (() => {
      try {
        return require("./printerLocalConfig").ler()?.porta;
      } catch (_) {
        return null;
      }
    })();
    const p = String(cfgPorta || info?.porta || "").trim();
    const portaOk =
      !p ||
      /^RAW:/i.test(p) ||
      /^TCP:\d{1,3}(\.\d{1,3}){3}:\d+$/i.test(p) ||
      /^COM\d+/i.test(p);
    push(
      "porta_raw_valida",
      portaOk,
      p
        ? portaOk
          ? p
          : `inválida: ${p} (use RAW:Nome ou TCP:192.168.x.x:9100)`
        : "sem porta",
    );
  } catch (_) {}

  const logo = printerLogo.ler();
  const logoAv = printerLogo.avaliarExibicaoLogo
    ? printerLogo.avaliarExibicaoLogo({ exibirLogo: true })
    : { ok: !!(logo.ativo && logo.existe), reason: null };
  if (logo.ativo || logo.existe) {
    push("logo_imprimivel", logoAv.ok, logoAv.ok ? "ok" : `omitida: ${logoAv.reason}`);
  } else {
    push("logo", true, "sem logo (ok)");
  }
  try {
    const runtime = require("./acbrPosPrinterRuntime");
    push("acbr_dll", runtime.canLoadNativeLib(), runtime.resolveLibPath() || "dll_missing");
    push(
      "acbr_circuito",
      !runtime.isAcbrPosCircuitOpen(),
      runtime.isAcbrPosCircuitOpen()
        ? `aberto: ${runtime.getAcbrPosCircuit()?.reason || "—"}`
        : "fechado",
    );
  } catch (_) {}

  const obs = printJobService.observabilidade();
  push("fila_impressao", (obs.fila?.erro || 0) < 5, `pend=${obs.fila?.pendente || 0} err=${obs.fila?.erro || 0}`);
  push("metricas", true, {
    tempoMedioMs: obs.tempoMedioMs,
    tempoMaximoMs: obs.tempoMaximoMs,
    porTipo: obs.porTipo,
    jobsProcessados: obs.stats?.jobsProcessados,
  });

  const falhas = checks.filter((c) => c.ok === false);
  return {
    ok: falhas.length === 0,
    checks,
    resumo: { total: checks.length, ok: checks.filter((c) => c.ok === true).length, falhas: falhas.length },
    observabilidade: obs,
    driver: driverInfo,
    logo: { ...logo, imprimivel: logoAv.ok, lastSkipReason: logoAv.reason },
  };
}

async function executarDiagnosticoImpressao(deps = {}) {
  const checks = [];
  const push = (id, ok, detalhe, extra = {}) => {
    checks.push({ id, ok: !!ok, detalhe: detalhe || null, ...extra });
  };

  let provider = null;
  let info = null;
  try {
    provider = factory.getPrintProvider();
    push("driver_carregado", !!provider, provider?.getProviderName?.() || "provider");
  } catch (err) {
    push("driver_carregado", false, err.message);
  }

  try {
    info = deps.impressoraInfo || (provider ? await provider.getInfo(true).catch(() => null) : null);
    push("impressora_encontrada", info?.ok || info?.conectada, info?.impressora?.nome || info?.detectada || null);
    push("porta_configurada", !!(info?.porta || info?.acbrPorta), info?.porta || info?.acbrPorta || null);
    push("modelo_identificado", !!(info?.modelo || info?.impressora?.modelo), info?.modelo || info?.impressora?.modelo || null);
  } catch (err) {
    push("impressora_encontrada", false, err.message);
  }

  const driverInfo = factory.getDriverInfo?.() || {};
  push("provider_ativo", !!driverInfo.provider, driverInfo.label || driverInfo.provider);
  push("acbr_modo", driverInfo.mode !== "unconfigured", driverInfo.mode || "unconfigured");

  try {
    const { checkPosprinterDeps } = require("../scripts/check-posprinter-deps");
    const depsReport = checkPosprinterDeps();
    push(
      "acbr_deps",
      depsReport.ok || process.platform !== "win32",
      process.platform !== "win32"
        ? "n/a (não Windows)"
        : depsReport.ok
          ? `ok (${depsReport.present?.length || 0} arquivos)`
          : `faltando: ${(depsReport.missing || []).slice(0, 5).join(", ")}`,
    );
  } catch (err) {
    push("acbr_deps", false, err.message);
  }

  try {
    const cfgPorta = (() => {
      try {
        return require("./printerLocalConfig").ler()?.porta;
      } catch (_) {
        return null;
      }
    })();
    const p = String(cfgPorta || info?.porta || "").trim();
    const portaOk =
      !p ||
      /^RAW:/i.test(p) ||
      /^TCP:\d{1,3}(\.\d{1,3}){3}:\d+$/i.test(p) ||
      /^COM\d+/i.test(p);
    push(
      "porta_raw_valida",
      !!p && portaOk,
      p
        ? portaOk
          ? p
          : `inválida: ${p} (use RAW:Nome ou TCP:192.168.x.x:9100)`
        : "sem porta",
    );
  } catch (_) {}

  if (driverInfo.mode === "native") {
    try {
      const runtime = require("./acbrPosPrinterRuntime");
      const status = await runtime.lerStatusFormatadoNative(2);
      push("acbr_inicializada", status?.ok !== false, status?.raw?.slice?.(0, 80) || "ok");
      push("comunicacao_impressora", status?.ok !== false && status?.status?.offLine !== 1, null);
      push("papel", status?.status?.semPapel !== 1, status?.status?.poucoPapel === 1 ? "pouco papel" : "ok");
    } catch (err) {
      push("acbr_inicializada", false, err.message);
      push("comunicacao_impressora", false, err.message);
    }
  } else {
    push("comunicacao_escpos", deps.impressoraOk === true, deps.impressoraOk === false ? "falhou" : "n/a");
  }

  const logo = printerLogo.ler();
  const logoAv = printerLogo.avaliarExibicaoLogo
    ? printerLogo.avaliarExibicaoLogo({ exibirLogo: true })
    : { ok: logo.ativo && logo.existe, reason: null };
  if (logo.ativo || logo.existe) {
    push(
      "logo_imprimivel",
      logoAv.ok,
      logoAv.ok ? "ok" : `omitida: ${logoAv.reason || "desconhecido"}`,
    );
  } else {
    push("logo_configurada", true, "sem logo (ok)");
  }

  try {
    const runtime = require("./acbrPosPrinterRuntime");
    const loaded = runtime.canLoadNativeLib();
    push("acbr_dll", loaded, loaded ? runtime.resolveLibPath() : "dll_missing");
    const circuit = runtime.getAcbrPosCircuit?.() || {};
    const circuitOpen = runtime.isAcbrPosCircuitOpen?.() || false;
    push(
      "acbr_circuito",
      !circuitOpen,
      circuitOpen
        ? `aberto: ${circuit.reason || "—"} — use Detectar para reativar`
        : "fechado",
    );
  } catch (err) {
    push("acbr_dll", false, err.message);
  }

  try {
    const warmState = global.__printWarmState || null;
    push(
      "warm_logo",
      warmState?.ok !== false,
      warmState
        ? `ok=${warmState.ok} ms=${warmState.ms}`
        : "ainda não aquecido (boot)",
    );
  } catch (_) {}

  try {
    const { getLastPrintMetrics } = require("./printMetrics");
    const lp = getLastPrintMetrics();
    push(
      "ultima_impressao",
      lp.at != null,
      lp.at
        ? `${lp.provider || "?"} ${lp.durationMs}ms logo=${lp.logoIncluded}`
        : "nenhuma",
    );
  } catch (_) {}

  const obs = printJobService.observabilidade();
  push("fila_impressao", (obs.fila?.erro || 0) < 5, `pend=${obs.fila?.pendente || 0} err=${obs.fila?.erro || 0}`);
  push("metricas_disponiveis", obs.tempoMedioMs != null || obs.stats?.jobsProcessados > 0, {
    tempoMedioMs: obs.tempoMedioMs,
    tempoMaximoMs: obs.tempoMaximoMs,
    jobsProcessados: obs.stats?.jobsProcessados,
    retries: obs.stats?.retries,
    porTipo: obs.porTipo,
  });

  const conectada = deps.impressoraOk === true || info?.conectada || info?.ok;
  if (conectada && provider && process.env.PRINT_DIAG_TESTE !== "false") {
    try {
      await provider.testar?.(true);
      push("impressao_teste", true, "probe ok");
    } catch (err) {
      push("impressao_teste", false, err.message);
    }
  } else {
    push("impressao_teste", null, "pulado — impressora offline");
  }

  const falhas = checks.filter((c) => c.ok === false);
  return {
    ok: falhas.length === 0,
    checks,
    resumo: {
      total: checks.length,
      ok: checks.filter((c) => c.ok === true).length,
      falhas: falhas.length,
      pulados: checks.filter((c) => c.ok == null).length,
    },
    observabilidade: obs,
    driver: driverInfo,
    logo: { ...logo, lastSkipReason: logoAv.reason, imprimivel: logoAv.ok },
  };
}

module.exports = { coletarDiagnosticoImpressaoSync, executarDiagnosticoImpressao };
