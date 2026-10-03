"use strict";

const fs = require("fs");
const { getDirectoryManager } = require("../../runtime/directoryManager");
const { SCALE_BAUD } = require("./constants");
const { resolveProtocol, isSupportedProtocol } = require("./protocol/registry");
const { ScaleError } = require("./errors");
const log = require("../../logger").child({ modulo: "scale_config" });

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  enabled: false,
  porta: "",
  baud: SCALE_BAUD,
  protocol: "TOLEDO_PRIX3_ENQ_STX5",
});

function configPath() {
  if (process.env.SCALE_CONFIG_OVERRIDE) {
    return process.env.SCALE_CONFIG_OVERRIDE;
  }
  return getDirectoryManager().file("config", "scale-checkout.json");
}

function validar(raw, { strictProtocol = false } = {}) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.schemaVersion = SCHEMA_VERSION;
  cfg.enabled = cfg.enabled === true;
  cfg.porta = cfg.porta == null ? "" : String(cfg.porta).trim();
  const baud = Number(cfg.baud);
  if (!Number.isFinite(baud) || baud < 2400 || baud > 9600) {
    throw new Error("baud deve ser número entre 2400 e 9600.");
  }
  cfg.baud = Math.floor(baud);

  if (strictProtocol && cfg.protocol != null && cfg.protocol !== "" && !isSupportedProtocol(cfg.protocol)) {
    throw new ScaleError("SCALE_PROTOCOL_UNSUPPORTED", { detail: String(cfg.protocol) });
  }
  const proto = resolveProtocol(cfg.protocol, { strict: strictProtocol });
  cfg.protocol = proto.id;
  if (cfg.enabled && !cfg.porta) {
    throw new Error("porta é obrigatória quando enabled=true.");
  }
  return cfg;
}

function ler() {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return validar(raw, { strictProtocol: false });
  } catch (err) {
    if (err instanceof ScaleError) throw err;
    log.warn({ err: err.message, path: p }, "[Scale] Config inválida — usando defaults");
    return { ...DEFAULTS };
  }
}

function salvar(patch) {
  const atual = ler();
  const next = validar(
    { ...atual, ...(patch && typeof patch === "object" ? patch : {}) },
    { strictProtocol: true },
  );
  const p = configPath();
  fs.mkdirSync(require("path").dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, p);
  log.info(
    {
      metric: "scale.config_save",
      enabled: next.enabled,
      porta: next.porta,
      baud: next.baud,
      protocol: next.protocol,
    },
    "[Scale] Config salva",
  );
  return next;
}

module.exports = {
  DEFAULTS,
  configPath,
  validar,
  ler,
  salvar,
};
