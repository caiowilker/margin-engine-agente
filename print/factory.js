/**
 * Factory PrinterProvider — resolução efetiva com fallback automático.
 */
require("dotenv").config();

const { assertPrinterProviderContract } = require("./contract");
const log = require("../logger").child({ modulo: "print_factory" });

const PROVIDERS = {
  native: () => require("./drivers/nativeEscPosProvider"),
  "acbr-posprinter": () => require("./drivers/acbrPosPrinterProvider"),
  acbrposprinter: () => require("./drivers/acbrPosPrinterProvider"),
  acbr: () => require("./drivers/acbrPosPrinterProvider"),
  mock: () => require("./drivers/mockPrinterProvider"),
};

const ALIASES = {
  escpos: "native",
  "native-escpos": "native",
  posprinter: "acbr-posprinter",
};

let cachedProvider = null;
let cachedName = null;
let cachedEffectiveName = null;

function normalizeProviderName(raw) {
  const key = String(raw || "acbr-posprinter")
    .trim()
    .toLowerCase();
  return ALIASES[key] || key;
}

function resolveProviderName() {
  const fromEnv =
    process.env.PRINTER_PROVIDER ||
    process.env.PRINT_DRIVER ||
    process.env.PRINTER_DRIVER ||
    "acbr-posprinter";
  return normalizeProviderName(fromEnv);
}

function resolveFallbackName() {
  const raw = process.env.PRINTER_FALLBACK || "native";
  return normalizeProviderName(raw);
}

function isProviderOperational(name) {
  try {
    const p = createProvider(name);
    const info = p.getDriverInfo?.() || {};
    if (name === "mock") return true;
    if (name === "native") return true;
    if (name === "acbr-posprinter") {
      return info.mode === "native" || info.mode === "parity";
    }
    return !!info.ready;
  } catch (_) {
    return false;
  }
}

function resolveEffectiveProviderName() {
  const requested = resolveProviderName();
  if (isProviderOperational(requested)) return requested;
  const fallback = resolveFallbackName();
  if (fallback !== requested && isProviderOperational(fallback)) {
    log.warn(
      { requested, fallback, reason: "provider_nao_operacional" },
      "[PrintFactory] Usando fallback de impressão",
    );
    return fallback;
  }
  return requested;
}

function createProvider(name) {
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `PRINTER_PROVIDER inválido: "${name}". Valores: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  const provider = factory();
  assertPrinterProviderContract(provider, name);
  return provider;
}

function getPrintProvider() {
  const effective = resolveEffectiveProviderName();
  if (!cachedProvider || cachedName !== effective) {
    cachedProvider = createProvider(effective);
    cachedName = effective;
    cachedEffectiveName = effective;
    const info = cachedProvider.getDriverInfo?.() || {};
    log.info(
      {
        requested: resolveProviderName(),
        effective,
        mode: info.mode,
        ready: info.ready,
      },
      "[PrintFactory] Provider de impressão ativo",
    );
  }
  return cachedProvider;
}

function getProviderName() {
  return cachedName || resolveEffectiveProviderName();
}

function getRequestedProviderName() {
  return resolveProviderName();
}

function getDriverInfo() {
  const p = getPrintProvider();
  const info = typeof p.getDriverInfo === "function" ? p.getDriverInfo() : {};
  return {
    ...info,
    requested: resolveProviderName(),
    effective: getProviderName(),
    fallback: resolveFallbackName(),
  };
}

function resetPrintProvider() {
  cachedProvider = null;
  cachedName = null;
  cachedEffectiveName = null;
  try {
    const runtime = require("./acbrPosPrinterRuntime");
    if (typeof runtime.invalidatePosPrinterSession === "function") {
      runtime.invalidatePosPrinterSession();
    }
  } catch (_) {}
}

function warnIfSelectedAtBoot() {
  const requested = resolveProviderName();
  if (requested !== "acbr-posprinter") return;
  const info = createProvider("acbr-posprinter").getDriverInfo();
  if (info.mode === "native") {
    log.info("[ACBrPosPrinter] Modo nativo — biblioteca PosPrinter carregada");
    return;
  }
  if (info.mode === "parity") {
    log.warn(
      "[ACBrPosPrinter] Modo PARITY (PRINTER_ALLOW_PARITY) — impressão via ESC/POS legado",
    );
    return;
  }
  log.error(
    "[ACBrPosPrinter] Biblioteca não encontrada — fallback automático para native",
  );
}

module.exports = {
  PROVIDERS,
  ALIASES,
  resolveProviderName,
  resolveEffectiveProviderName,
  resolveFallbackName,
  createProvider,
  getPrintProvider,
  getProviderName,
  getRequestedProviderName,
  getDriverInfo,
  resetPrintProvider,
  warnIfSelectedAtBoot,
  isProviderOperational,
};
