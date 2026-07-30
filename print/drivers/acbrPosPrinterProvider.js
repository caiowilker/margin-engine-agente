/**
 * AcbrPosPrinterProvider — ACBrLib PosPrinter (padrão 1.0).
 *
 * Caminho oficial: tags ACBr via DLL (koffi). ESC/POS nativo fica só como
 * retaguarda (PRINTER_FALLBACK / PRINT_FAST_NATIVE=true / lib ausente).
 */
const log = require("../../logger").child({ modulo: "acbr_posprinter" });
const runtime = require("../acbrPosPrinterRuntime");
const { renderPaginaTeste } = require("../cupomAcbrTags");
const { renderPayloadTags } = require("../renderPrint");
const { normalizarCupomPayload, deveRelaxarQr } = require("../cupomValidate");
const native = require("./nativeEscPosProvider");
const caixaTags = require("../caixaAcbrTags");
const pedidoTags = require("../pedidoAcbrTags");

/**
 * Prefere ESC/POS nativo vs ACBr tags.
 * Padrão: ACBr (PRINT_FAST_NATIVE=false). Native só com flag explícita
 * ou como retaguarda quando a DLL/ffi não carrega.
 */
function preferNativeEscPos(payload) {
  const flag = String(process.env.PRINT_FAST_NATIVE || "false").toLowerCase();
  if (flag === "false" || flag === "0" || flag === "") return false;
  if (flag === "always") return true;
  // PRINT_FAST_NATIVE=true → só ops comerciais no native; fiscal com chave no ACBr
  if (!payload || typeof payload !== "object") return true;
  if (payload.naoFiscal === true || payload.cupomSemFiscal === true) return true;
  if (payload.chaveNfe && !payload.naoFiscal && !payload.cupomSemFiscal) return false;
  if (payload.somenteDanfeTermico || payload.danfeTermico) return false;
  if (payload.layout === "danfe-termico") return false;
  return true;
}

async function imprimirViaTags(renderFn, payload, fallbackNative) {
  const mode = getIntegrationMode();
  if (mode === "parity" || preferNativeEscPos(payload)) {
    return fallbackNative(payload);
  }
  const tags = renderFn(payload || {});
  const t0 = Date.now();
  await imprimirTags(tags);
  return {
    ok: true,
    provider: "acbr-posprinter",
    durationMs: Date.now() - t0,
    lines: tags.split("\n").length,
  };
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
  return {
    ...DRIVER_INFO,
    mode,
    native: mode === "native",
    parity: mode === "parity",
    libPath: runtime.resolveLibPath(),
    iniPath: runtime.resolveIniPath(),
    ready: mode === "native" || mode === "parity",
    fastNative: String(process.env.PRINT_FAST_NATIVE || "false"),
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
  const mode = getIntegrationMode();
  if (mode === "parity" || preferNativeEscPos({ naoFiscal: true })) {
    return native.imprimirTeste();
  }
  const tags = renderPaginaTeste();
  await imprimirTags(tags);
  if ((process.env.PRINTER_DRAWER || "true").toLowerCase() !== "false") {
    try {
      await abrirGaveta();
    } catch (err) {
      log.warn({ err: err.message }, "[ACBrPosPrinter] Gaveta no teste falhou (ignorado)");
    }
  }
  return { ok: true, teste: true, provider: "acbr-posprinter" };
}

async function abrirGaveta() {
  const mode = getIntegrationMode();
  if (mode !== "native" || preferNativeEscPos({ naoFiscal: true })) {
    return native.abrirGaveta();
  }
  return runtime.abrirGavetaNative();
}

module.exports = {
  getProviderName,
  getDriverInfo,
  preferNativeEscPos,
  testar: async (force) => {
    try {
      const det = await native.detectar(force);
      if (det?.impressora) {
        require("../printerLocalConfig").sincronizarDeDeteccao(det);
        try {
          require("../factory").resetPrintProvider();
        } catch (_) {}
      }
      // Com fast-native: não abrir sessão ACBr só para probe (Ativar lento / agente off)
      if (getIntegrationMode() === "native" && !preferNativeEscPos({ naoFiscal: true })) {
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
  detectar: async () => {
    const bootstrap = require("../printerBootstrap");
    const result = await bootstrap.autoDetectarESincronizar({ force: true });
    return result.info || { ok: false };
  },
  imprimirCupom,
  imprimirSegundaVia,
  imprimirTags,
  imprimirTeste,
  imprimirAbertura: (p) => imprimirViaTags(caixaTags.renderAberturaTags, p, native.imprimirAbertura),
  imprimirFechamento: (p) =>
    imprimirViaTags(caixaTags.renderFechamentoTags, p, native.imprimirFechamento),
  imprimirMovimentoCaixa: (p) =>
    imprimirViaTags(caixaTags.renderMovimentoCaixaTags, p, native.imprimirMovimentoCaixa),
  imprimirPedido: (p) => {
    const routes = require("../printerStationRoutes");
    const porta = routes.resolvePortaForPrintType(p?.printType ?? p?.print_type);
    // Native ESC/POS lê override em enviarBuffer — sem Desativar×2 por comanda
    const invalidateAcbr = !preferNativeEscPos(p || {});
    return routes.withPortaOverride(
      porta,
      () => imprimirViaTags(pedidoTags.renderPedidoTags, p, native.imprimirPedido),
      { invalidateAcbr },
    );
  },
  abrirGaveta,
};
