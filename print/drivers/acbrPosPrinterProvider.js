/**
 * AcbrPosPrinterProvider — ACBrLib PosPrinter (padrão 1.0).
 *
 * Comercial em porta RAW:Windows: ESC/POS nativo por default (PRINT_FAST_NATIVE=raw).
 * Fiscal/DANFE e TCP/COM: ACBr PosPrinter. Circuito / gaveta / fallback pré-impressão
 * também forçam native.
 */
const log = require("../../logger").child({ modulo: "acbr_posprinter" });
const runtime = require("../acbrPosPrinterRuntime");
const { renderPayloadTags } = require("../renderPrint");
const { normalizarCupomPayload, deveRelaxarQr } = require("../cupomValidate");
const native = require("./nativeEscPosProvider");

/**
 * Tags opcionais — lazy require.
 * Nunca require no load do provider: arquivo ausente no deploy (vasilhameAcbrTags etc.)
 * derrubava TODA impressão (teste/cupom) com "Cannot find module".
 */
function loadAcbrTags(modName) {
  // eslint-disable-next-line import/no-dynamic-require
  return require(`../${modName}`);
}

/**
 * Prefere ESC/POS nativo vs ACBr tags.
 *
 * Default PRINT_FAST_NATIVE=raw:
 * - Porta RAW:Windows → native no comercial (ACBr Ativar em RAW costuma hang;
 *   Win32 WritePrinter tipicamente ~200ms neste parque).
 * - Fiscal/DANFE com chave → ACBr.
 * - Circuito aberto → native comercial.
 *
 * Overrides: false|0 = ACBr em TCP/COM; em RAW:Windows comercial permanece native
 *   (ACBr Ativar em RAW costuma hang — false não pode deixar o PDV sem papel).
 *   true = comercial native; always = tudo native.
 */
function isFiscalPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.naoFiscal === true || payload.cupomSemFiscal === true) return false;
  if (payload.chaveNfe) return true;
  if (payload.somenteDanfeTermico || payload.danfeTermico) return true;
  if (payload.layout === "danfe-termico") return true;
  return false;
}

/** Porta RAW:NomeWindows — usada por diagnóstico / gaveta / fast-path native. */
function portaEhRawWindows() {
  try {
    const local = require("../printerLocalConfig").ler()?.porta;
    if (local != null && String(local).trim() !== "") {
      return /^RAW:/i.test(String(local).trim());
    }
  } catch (_) {
    /* ignore */
  }
  return /^RAW:/i.test(String(process.env.PRINTER_PORTA || "").trim());
}

function preferNativeEscPos(payload) {
  try {
    if (runtime.isAcbrPosCircuitOpen()) {
      // Circuito aberto: comercial sempre native; em RAW:Windows fiscal também
      // (evita Ativar ~4.5s+ a cada NFC-e quando ACBr já está morto).
      if (!isFiscalPayload(payload)) return true;
      if (portaEhRawWindows()) return true;
    }
  } catch (_) {
    /* runtime opcional em testes */
  }
  const flag = String(process.env.PRINT_FAST_NATIVE || "raw").toLowerCase();
  if (flag === "false" || flag === "0") {
    // Pedido explícito de ACBr — mas RAW:Windows comercial fica no native
    // (parque POS80: Ativar/hang; .env legado false não pode matar cupom/teste).
    if (portaEhRawWindows() && !isFiscalPayload(payload)) return true;
    return false;
  }
  if (flag === "always") return true;
  if (flag === "raw" || flag === "auto" || flag === "") {
    if (portaEhRawWindows() && !isFiscalPayload(payload)) return true;
    return false;
  }
  // PRINT_FAST_NATIVE=true → comerciais no native; fiscal/DANFE no ACBr
  if (!payload || typeof payload !== "object") return true;
  if (payload.naoFiscal === true || payload.cupomSemFiscal === true) return true;
  if (isFiscalPayload(payload)) return false;
  return true;
}

async function imprimirViaTags(renderFn, payload, fallbackNative, opts = {}) {
  const mode = getIntegrationMode();
  if (mode === "parity" || preferNativeEscPos(payload)) {
    return fallbackNative(payload);
  }
  const tags = renderFn(payload || {});
  const t0 = Date.now();
  // Gaveta antecipada: abre já (troco/fundo), enquanto o comprovante imprime.
  const gavetaEarly = dispararGavetaAntecipada(payload, opts);
  await imprimirTags(tags);
  if (gavetaEarly) {
    try {
      await gavetaEarly;
    } catch (_) {
      /* pós-tags tenta de novo abaixo */
    }
  }
  await talvezAbrirGavetaAposAcbr(payload, opts);
  return {
    ok: true,
    provider: "acbr-posprinter",
    durationMs: Date.now() - t0,
    lines: tags.split("\n").length,
  };
}

/** Dispara pulso ESC/POS sem bloquear o início da impressão ACBr. */
function dispararGavetaAntecipada(payload, opts = {}) {
  try {
    const core = require("../escpos/impressoraCore");
    const deve =
      typeof core.deveAbrirGavetaNoPayload === "function" &&
      core.deveAbrirGavetaNoPayload(payload, { sempre: opts.sempre === true });
    if (!deve) return null;
    return abrirGaveta({ force: opts.force === true }).catch((err) => {
      log.warn({ err: err?.message }, "[ACBrPosPrinter] Gaveta antecipada falhou");
      throw err;
    });
  } catch (_) {
    return null;
  }
}

/** Após tags ACBr: pulso ESC/POS nativo (sem segunda sessão PosPrinter). */
async function talvezAbrirGavetaAposAcbr(payload, opts = {}) {
  try {
    const core = require("../escpos/impressoraCore");
    const deve =
      typeof core.deveAbrirGavetaNoPayload === "function" &&
      core.deveAbrirGavetaNoPayload(payload, { sempre: opts.sempre === true });
    if (!deve) return;
    await abrirGaveta({ force: opts.force === true });
  } catch (err) {
    log.warn({ err: err?.message }, "[ACBrPosPrinter] Gaveta pós-tags falhou (ignorado)");
  }
}

const DRIVER_INFO = {
  provider: "acbr-posprinter",
  label: "ACBrLib PosPrinter",
  transport: "ffi",
};

function getIntegrationMode() {
  if (runtime.canLoadNativeLib()) return "native";
  if (process.env.PRINTER_ALLOW_PARITY === "true") return "parity";
  return "unconfigured";
}

function getDriverInfo() {
  const mode = getIntegrationMode();
  let posWorker = false;
  let posWorkerActive = false;
  try {
    const pool = require("../acbrPosWorkerPool");
    posWorker = pool.isPosWorkerEnabled();
    posWorkerActive = pool.hasActiveWorker();
  } catch (_) {}
  let circuit = { open: false, reason: null, openedAt: null };
  try {
    circuit = runtime.getAcbrPosCircuit();
  } catch (_) {}
  const circuitOpen = (() => {
    try {
      return runtime.isAcbrPosCircuitOpen();
    } catch (_) {
      return false;
    }
  })();
  let lastPrint = null;
  try {
    lastPrint = require("../printMetrics").getLastPrintMetrics();
  } catch (_) {}
  let loadReason = null;
  if (mode !== "native") {
    if (process.platform !== "win32") loadReason = "not_win32";
    else if (!runtime.resolveLibPath()) loadReason = "dll_missing";
    else if (!runtime.canRequireFfiBindings?.()) loadReason = "koffi";
    else loadReason = "unconfigured";
  }
  const effectiveMode =
    mode === "native" && circuitOpen
      ? "native_circuit"
      : mode === "native"
        ? "acbr"
        : mode === "parity"
          ? "parity"
          : "native_fallback";
  return {
    ...DRIVER_INFO,
    mode,
    effectiveMode,
    native: mode === "native",
    parity: mode === "parity",
    libPath: runtime.resolveLibPath(),
    iniPath: runtime.resolveIniPath(),
    ready: mode === "native" || mode === "parity",
    fastNative: String(process.env.PRINT_FAST_NATIVE || "raw"),
    posWorker,
    posWorkerActive,
    usbTopology: String(process.env.PHYSICAL_USB_TOPOLOGY || "separate"),
    acbrCircuitOpen: circuitOpen,
    acbr: {
      loaded: mode === "native",
      libPath: runtime.resolveLibPath(),
      koffiOk: !!runtime.canRequireFfiBindings?.(),
      loadReason,
      circuit: {
        open: circuitOpen,
        reason: circuit.reason || null,
        openedAt: circuit.openedAt || null,
      },
      lastPhase: (() => {
        try {
          return runtime.getAcbrPrintPhase?.() || null;
        } catch (_) {
          return null;
        }
      })(),
    },
    lastPrint,
  };
}

function getProviderName() {
  return "acbr-posprinter";
}

async function imprimirTags(tags) {
  const mode = getIntegrationMode();
  if (mode === "native") {
    return runtime.imprimirTagsNative(tags);
  }
  if (mode === "parity") {
    throw new Error("[ACBrPosPrinter] imprimirTags requer biblioteca nativa (modo parity)");
  }
  throw new Error(
    "[ACBrPosPrinter] Biblioteca não encontrada. Configure ACBR_POSPRINTER_LIB_PATH ou PRINTER_ALLOW_PARITY=true",
  );
}

async function imprimirPayloadTags(payload) {
  const normalizado = normalizarCupomPayload(payload, {
    relaxQr: deveRelaxarQr(payload),
  });
  const mode = getIntegrationMode();
  if (mode === "parity" || preferNativeEscPos(normalizado)) {
    if (preferNativeEscPos(normalizado) && mode === "native") {
      log.info(
        {
          numeroVenda: normalizado?.numeroVenda,
          naoFiscal: !!normalizado?.naoFiscal,
        },
        "[ACBrPosPrinter] Fast-path ESC/POS nativo",
      );
    }
    return native.imprimirCupom(normalizado);
  }
  const { resolverQrBmpPlaceholders } = require("../qrCodeAcbrBmp");
  let tags = renderPayloadTags(normalizado);
  tags = await resolverQrBmpPlaceholders(tags, normalizado);
  const t0 = Date.now();
  const res = await imprimirTags(tags);
  await talvezAbrirGavetaAposAcbr(normalizado);
  return {
    ...res,
    ok: true,
    provider: "acbr-posprinter",
    durationMs: Date.now() - t0,
    lines: tags.split("\n").length,
    layout: require("../renderPrint").escolherRenderizador(normalizado),
  };
}

async function imprimirCupom(payload) {
  return imprimirPayloadTags(payload);
}

async function imprimirSegundaVia(payload) {
  return imprimirPayloadTags(payload);
}

async function imprimirTeste() {
  // Teste SEMPRE ESC/POS nativo — independente de PRINT_FAST_NATIVE / ACBr.
  // ACBr Ativar em RAW:Windows costuma hang; página de teste não pode ficar sem papel.
  const t0 = Date.now();
  const logoMod = require("../printerLogo");
  const logoAv = logoMod.avaliarExibicaoLogo({ exibirLogo: true });
  const metrics = require("../printMetrics");

  const gavetaEarly =
    (process.env.PRINTER_DRAWER || "true").toLowerCase() !== "false"
      ? abrirGaveta({ force: true }).catch((err) => {
          log.warn({ err: err.message }, "[ACBrPosPrinter] Gaveta no teste (native) falhou");
        })
      : null;
  const res = await native.imprimirTeste();
  if (gavetaEarly) await Promise.resolve(gavetaEarly).catch(() => {});
  const durationMs = Date.now() - t0;
  const out = {
    ...res,
    ok: true,
    teste: true,
    provider: "native",
    durationMs,
    logoIncluded: logoAv.ok,
    logoSkipReason: logoAv.reason,
    circuitOpen: (() => {
      try {
        return runtime.isAcbrPosCircuitOpen();
      } catch (_) {
        return false;
      }
    })(),
    hintTcp:
      "Se USB travar, configure porta TCP:IP:9100 (ex.: TCP:192.168.1.50:9100).",
  };
  metrics.recordPrintResult({
    durationMs,
    provider: "native",
    op: "imprimirTeste",
    logoIncluded: logoAv.ok,
    logoSkipReason: logoAv.reason,
    ok: true,
  });
  return out;
}

async function abrirGaveta(opts = {}) {
  // Gaveta nunca é fiscal — sempre ESC/POS nativo (evita Ativar -10 em RAW).
  return native.abrirGaveta(opts);
}

module.exports = {
  getProviderName,
  getDriverInfo,
  preferNativeEscPos,
  portaEhRawWindows,
  isFiscalPayload,
  // Poll/status: somente leitura — NÃO sincronizarDeDeteccao / resetPrintProvider
  // (isso reinfectava o spooler a cada /status e marcava Agente off).
  testar: async (force) => {
    try {
      const det = await native.detectar(force);
      // NUNCA abrir sessão ACBr no poll de status — POS_*/threadpool prende o agente
      // ("Offline", lista vazia). Live status só com flag explícita.
      if (
        getIntegrationMode() === "native" &&
        process.env.PRINTER_ACBR_LIVE_STATUS === "true" &&
        !preferNativeEscPos({ naoFiscal: true })
      ) {
        try {
          const status = await runtime.lerStatusFormatadoNative(2);
          if (status?.ok === false) return false;
          if (status?.ok === true) return true;
          return !!det?.impressora;
        } catch (_) {
          return !!det?.impressora;
        }
      }
      if (det?.impressora) return true;
      // native.testar também é read-only (sem sync) — ver impressoraCore.testar
      return native.testar(force);
    } catch (_) {
      return false;
    }
  },
  getInfo: async (force) => {
    const mode = getIntegrationMode();
    const det = await native.getInfo(force).catch(() => null);
    let local = null;
    try {
      local = require("../printerLocalConfig").ler();
    } catch (_) {}
    // Live status ACBr só sob demanda — evita hang no boot/poll do PDV
    if (mode === "native" && process.env.PRINTER_ACBR_LIVE_STATUS === "true") {
      try {
        const [versao, status] = await Promise.all([
          runtime.lerVersaoNative().catch(() => null),
          runtime.lerStatusFormatadoNative(2).catch(() => null),
        ]);
        return {
          ok: status?.ok !== false,
          conectada: status?.ok !== false,
          provider: "acbr-posprinter",
          mode,
          lib: versao,
          statusImpressora: status,
          impressora: det?.impressora || null,
          acbrPorta: local?.porta || process.env.PRINTER_PORTA || null,
          candidatos: det?.candidatos || [],
          ...getDriverInfo(),
        };
      } catch (err) {
        log.warn({ err: err.message }, "[ACBrPosPrinter] getInfo nativo falhou — fallback ESC/POS");
      }
    }
    const base = det || (await native.getInfo(force));
    return {
      ...base,
      ok: mode !== "unconfigured" ? base?.ok : false,
      conectada: mode !== "unconfigured" ? base?.conectada ?? base?.ok : false,
      provider: "acbr-posprinter",
      mode,
      acbrPorta: local?.porta || process.env.PRINTER_PORTA || null,
      ...getDriverInfo(),
    };
  },
  listar: () => ({ ...native.listar(), provider: "acbr-posprinter", ...getDriverInfo() }),
  // Operador "Detectar" (force): sync + reset circuito + probe ACBr (1 linha + logo se houver).
  detectar: async (force = true) => {
    const bootstrap = require("../printerBootstrap");
    const forceSync = force !== false;
    const result = await bootstrap.autoDetectarESincronizar({ force: forceSync });
    if (forceSync) {
      try {
        runtime.resetAcbrPosCircuit();
      } catch (_) {
        /* ignore */
      }
    }

    let acbrProbe = null;
    // RAW:Windows comercial nunca precisa de Ativar — probe ACBr só atrasa/abre circuito.
    const skipAcbrProbe =
      typeof portaEhRawWindows === "function" &&
      portaEhRawWindows() &&
      preferNativeEscPos({ naoFiscal: true });
    if (forceSync && runtime.canLoadNativeLib() && !skipAcbrProbe) {
      const logoMod = require("../printerLogo");
      const { tagLogoHeader, tagCorte } = require("../acbrTags");
      const av = logoMod.avaliarExibicaoLogo({ exibirLogo: true });
      const logoTag = tagLogoHeader({ exibirLogo: true });
      const tags = `</zera>\n${logoTag}<ce>PROBE ACBr OK</ce>\n${tagCorte("partial")}\n`;
      const t0 = Date.now();
      try {
        await runtime.imprimirTagsNative(tags);
        acbrProbe = {
          ok: true,
          durationMs: Date.now() - t0,
          logoIncluded: !!(av.ok && /<bmp\b/i.test(logoTag)),
          logoSkipReason: av.ok ? null : av.reason,
        };
        log.info(
          { ...acbrProbe, metric: "print.acbr_detect_probe_ok" },
          "[ACBrPosPrinter] Probe pós-Detectar OK",
        );
      } catch (err) {
        acbrProbe = {
          ok: false,
          durationMs: Date.now() - t0,
          error: err?.message || String(err),
          code: err?.code || err?.acbrRet || null,
          logoSkipReason: av.reason,
        };
        log.warn(
          { ...acbrProbe, metric: "print.acbr_detect_probe_fail" },
          "[ACBrPosPrinter] Probe pós-Detectar falhou",
        );
        try {
          if (runtime.shouldOpenCircuitFromError?.(err)) {
            runtime.openAcbrPosCircuit?.(err.message || "detect_probe_fail");
          }
        } catch (_) {}
      }
    } else if (forceSync && !runtime.canLoadNativeLib()) {
      const infoDrv = getDriverInfo();
      acbrProbe = {
        ok: false,
        error: "Biblioteca ACBr PosPrinter indisponível neste PC",
        loadReason: infoDrv.acbr?.loadReason || "dll_missing",
      };
    }

    let base = result.info ? { ...result.info } : {};
    if (result.ok) {
      base.ok = true;
      if (result.skipped) base.skipped = true;
      if (!base.porta) {
        try {
          base.porta = require("../printerLocalConfig").ler({ fresh: true })?.porta;
        } catch (_) {}
      }
    } else {
      base.ok = false;
    }

    return {
      ...base,
      acbrProbe,
      driver: getDriverInfo(),
    };
  },
  imprimirCupom,
  imprimirSegundaVia,
  imprimirTags,
  imprimirTeste,
  imprimirTesteBarcode: (opts) => native.imprimirTesteBarcode(opts),
  imprimirAbertura: (p) =>
    imprimirViaTags(
      loadAcbrTags("caixaAcbrTags").renderAberturaTags,
      p,
      native.imprimirAbertura,
      { sempre: true },
    ),
  imprimirFechamento: (p) =>
    imprimirViaTags(
      loadAcbrTags("caixaAcbrTags").renderFechamentoTags,
      p,
      native.imprimirFechamento,
    ),
  imprimirMovimentoCaixa: (p) =>
    imprimirViaTags(
      loadAcbrTags("caixaAcbrTags").renderMovimentoCaixaTags,
      p,
      native.imprimirMovimentoCaixa,
      { sempre: true },
    ),
  imprimirPedido: (p) => {
    const routes = require("../printerStationRoutes");
    const porta = routes.requirePortaForPrintType(p?.printType ?? p?.print_type);
    // Override de porta sem invalidate — sessão quente; worker re-Ativa se Porta mudar
    return routes.withPortaOverride(porta, () =>
      imprimirViaTags(
        loadAcbrTags("pedidoAcbrTags").renderPedidoTags,
        p,
        native.imprimirPedido,
      ),
    );
  },
  imprimirVasilhame: (p) =>
    imprimirViaTags(
      loadAcbrTags("vasilhameAcbrTags").renderVasilhameTags,
      p,
      native.imprimirVasilhame,
    ),
  imprimirCrediario: (p) =>
    imprimirViaTags(
      loadAcbrTags("crediarioAcbrTags").renderCrediarioTags,
      p,
      native.imprimirCrediario,
    ),
  /** Etiqueta ZPL/PPLA — sempre nativo (nunca tags ACBr). */
  imprimirRaw: (p) => require("../rawLabelPrint").imprimirRaw(p),
  abrirGaveta,
};
