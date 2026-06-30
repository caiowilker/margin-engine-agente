/**
 * Factory do driver fiscal — resolve ACBR_DRIVER (monitor | lib).
 * Oficial 1.0: lib (ACBrLib Pro). Fallback: monitor (ACBr Monitor TCP).
 * Ambiente SEFAZ (homolog/prod) vem do acbrlib.ini, não deste factory.
 */
require("dotenv").config();

const { assertFiscalDriverContract } = require("./contract");
const log = require("../logger").child({ modulo: "fiscal_factory" });

const PROVIDERS = {
  monitor: () => require("./drivers/acbrMonitorDriver"),
  lib: () => require("./drivers/acbrLibDriver"),
};

/** Alias aceitos em config */
const ALIASES = {
  "acbr-monitor": "monitor",
  acbrmonitor: "monitor",
  monitor: "monitor",
  "acbr-lib": "lib",
  acbrlib: "lib",
  lib: "lib",
};

let cachedDriver = null;
let cachedName = null;

function normalizeDriverName(raw) {
  const key = String(raw || "lib")
    .trim()
    .toLowerCase();
  return ALIASES[key] || key;
}

function resolveDriverName() {
  const fromEnv =
    process.env.ACBR_DRIVER ||
    process.env.FISCAL_PROVIDER ||
    process.env.FISCAL_DRIVER ||
    "lib";
  return normalizeDriverName(fromEnv);
}

function createDriver(name) {
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `ACBR_DRIVER inválido: "${name}". Valores: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  const driver = factory();
  assertFiscalDriverContract(driver, name);
  if (name === "lib" && driver.warnIfSelectedAtBoot) {
    driver.warnIfSelectedAtBoot();
  }
  return driver;
}

function getFiscalDriver() {
  const name = resolveDriverName();
  if (!cachedDriver || cachedName !== name) {
    cachedDriver = createDriver(name);
    cachedName = name;
    log.info({ driver: name }, "[FiscalFactory] Driver fiscal ativo");
  }
  return cachedDriver;
}

function getDriverName() {
  return cachedName || resolveDriverName();
}

function getDriverInfo() {
  const driver = getFiscalDriver();
  if (typeof driver.getDriverInfo === "function") {
    return driver.getDriverInfo();
  }
  return { provider: getDriverName(), ready: true };
}

/** Apenas para testes — força recarga após mudar process.env */
function resetFiscalDriver() {
  cachedDriver = null;
  cachedName = null;
}

module.exports = {
  PROVIDERS,
  ALIASES,
  resolveDriverName,
  createDriver,
  getFiscalDriver,
  getDriverName,
  getDriverInfo,
  resetFiscalDriver,
};
