/**
 * AcbrPosPrinterProvider — ACBrLib PosPrinter (padrão 1.0).
 */
const log = require("../../logger").child({ modulo: "acbr_posprinter" });
const runtime = require("../acbrPosPrinterRuntime");
const { renderPaginaTeste } = require("../cupomAcbrTags");
const { renderPayloadTags } = require("../renderPrint");
const { normalizarCupomPayload } = require("../cupomValidate");
const native = require("./nativeEscPosProvider");
const caixaTags = require("./caixaAcbrTags");

async function imprimirViaTags(renderFn, payload, fallbackNative) {
  const mode = getIntegrationMode();
  if (mode === "parity") {
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
  const normalizado = normalizarCupomPayload(payload);
  const mode = getIntegrationMode();
  if (mode === "parity") {
    return native.imprimirCupom(normalizado);
  }
  const tags = renderPayloadTags(normalizado);
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
  if (mode === "parity") {
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
  if (mode === "native") {
    return runtime.abrirGavetaNative();
  }
  return native.abrirGaveta();
}

module.exports = {
  getProviderName,
  getDriverInfo,
  testar: async (force) => {
    try {
      const det = await native.detectar(force);
      if (det?.impressora) {
        require("../printerLocalConfig").sincronizarDeDeteccao(det);
        try {
          require("../factory").resetPrintProvider();
        } catch (_) {}
      }
      if (getIntegrationMode() === "native") {
        try {
          await imprimirTags("</zera><ce>OK</ce></corte_parcial>\n");
          return true;
        } catch (err) {
          log.warn({ err: err.message }, "[ACBrPosPrinter] Teste ACBr falhou — tentando spooler");
          const local = require("../printerLocalConfig").ler();
          const porta = String(local?.porta || process.env.PRINTER_PORTA || "");
          if (/^RAW:/i.test(porta) || det?.impressora?.metodo === "windows") {
            const okNative = await native.testar(force);
            if (okNative) return true;
          }
          try {
            const status = await runtime.lerStatusFormatadoNative(2);
            if (status?.ok) return true;
          } catch (_) {}
          return false;
        }
      }
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
    if (mode === "native") {
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
  abrirGaveta,
};
