/**
 * AcbrPosPrinterProvider — ACBrLib PosPrinter (padrão 1.0).
 */
const log = require("../../logger").child({ modulo: "acbr_posprinter" });
const runtime = require("../acbrPosPrinterRuntime");
const { renderPaginaTeste } = require("../cupomAcbrTags");
const { renderPayloadTags } = require("../renderPrint");
const { normalizarCupomPayload } = require("../cupomValidate");
const native = require("./nativeEscPosProvider");

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
      if (getIntegrationMode() === "native") {
        await imprimirTags("</zera><ce>OK</ce></corte_parcial>\n");
        return true;
      }
      return native.testar(force);
    } catch (_) {
      return false;
    }
  },
  getInfo: async (force) => {
    const mode = getIntegrationMode();
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
          ...getDriverInfo(),
        };
      } catch (err) {
        log.warn({ err: err.message }, "[ACBrPosPrinter] getInfo nativo falhou — fallback ESC/POS");
      }
    }
    const base = await native.getInfo(force);
    return {
      ...base,
      ok: mode !== "unconfigured" ? base.ok : false,
      conectada: mode !== "unconfigured" ? base.conectada ?? base.ok : false,
      provider: "acbr-posprinter",
      mode,
    };
  },
  listar: () => ({ ...native.listar(), provider: "acbr-posprinter", ...getDriverInfo() }),
  detectar: async () => {
    const info = await native.detectar();
    try {
      require("../printerLocalConfig").sincronizarDeDeteccao(info);
    } catch (_) {}
    return info;
  },
  imprimirCupom,
  imprimirSegundaVia,
  imprimirTags,
  imprimirTeste,
  imprimirAbertura: (p) => native.imprimirAbertura(p),
  imprimirFechamento: (p) => native.imprimirFechamento(p),
  imprimirMovimentoCaixa: (p) => native.imprimirMovimentoCaixa(p),
  abrirGaveta,
};
