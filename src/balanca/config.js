"use strict";

const fs = require("fs");
const path = require("path");
const { getDirectoryManager } = require("../../runtime/directoryManager");
const log = require("../../logger").child({ modulo: "balanca_config" });

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  enabled: false,
  gerenciadorId: null,
  pastaCarga: "",
  encoding: "windows-1252",
  timeoutImportacaoSeg: 120,
  intervaloPollingBakMs: 1000,
  modoSombra: true,
  pollBackendMs: 15000,
  modoEntrega: "PASTA",
  wsBaseUrl: "",
  wsLojaCodigo: 1,
  wsTipoImportacao: 1,
  wsOpcaoComunicacao: 2,
});

function configPath() {
  if (process.env.BALANCA_CONFIG_OVERRIDE) {
    return process.env.BALANCA_CONFIG_OVERRIDE;
  }
  return getDirectoryManager().file("config", "balanca-carga.json");
}

function auditDir(pastaCarga) {
  const base = pastaCarga && String(pastaCarga).trim()
    ? String(pastaCarga).trim()
    : getDirectoryManager().dir("diagnostics");
  return path.join(base, "_margin_balanca_sombra");
}

/**
 * Valida e normaliza config. Lança Error com mensagem em PT se inválida.
 */
function validar(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.schemaVersion = SCHEMA_VERSION;
  cfg.enabled = cfg.enabled === true;
  cfg.modoSombra = cfg.modoSombra !== false;
  cfg.pastaCarga = cfg.pastaCarga == null ? "" : String(cfg.pastaCarga).trim();
  cfg.encoding = (cfg.encoding && String(cfg.encoding).trim()) || "windows-1252";
  cfg.gerenciadorId =
    cfg.gerenciadorId == null || cfg.gerenciadorId === ""
      ? null
      : String(cfg.gerenciadorId).trim();

  const timeout = Number(cfg.timeoutImportacaoSeg);
  if (!Number.isFinite(timeout) || timeout < 5 || timeout > 3600) {
    throw new Error(
      "timeoutImportacaoSeg deve ser número entre 5 e 3600. Ajuste balanca-carga.json.",
    );
  }
  cfg.timeoutImportacaoSeg = Math.floor(timeout);

  const pollBak = Number(cfg.intervaloPollingBakMs);
  if (!Number.isFinite(pollBak) || pollBak < 200 || pollBak > 60_000) {
    throw new Error(
      "intervaloPollingBakMs deve ser número entre 200 e 60000.",
    );
  }
  cfg.intervaloPollingBakMs = Math.floor(pollBak);

  const pollBe = Number(cfg.pollBackendMs);
  if (!Number.isFinite(pollBe) || pollBe < 3000 || pollBe > 300_000) {
    throw new Error("pollBackendMs deve ser número entre 3000 e 300000.");
  }
  cfg.pollBackendMs = Math.floor(pollBe);

  cfg.pollBackendMs = Math.floor(pollBe);

  const modoEntrega = String(cfg.modoEntrega || "PASTA").toUpperCase();
  const modosOk = new Set([
    "PASTA",
    "PASTA_MONITORADA",
    "PASTA_GATILHO_POR_DATA",
    "MANUAL",
    "WS_MGV7",
  ]);
  if (!modosOk.has(modoEntrega)) {
    throw new Error(
      "modoEntrega deve ser PASTA, PASTA_MONITORADA, PASTA_GATILHO_POR_DATA, MANUAL ou WS_MGV7.",
    );
  }
  cfg.modoEntrega = modoEntrega;
  cfg.wsBaseUrl = cfg.wsBaseUrl == null ? "" : String(cfg.wsBaseUrl).trim();
  cfg.wsLojaCodigo = Number(cfg.wsLojaCodigo) || 1;
  cfg.wsTipoImportacao = Number(cfg.wsTipoImportacao) || 1;
  cfg.wsOpcaoComunicacao = Number(cfg.wsOpcaoComunicacao);
  if (!Number.isFinite(cfg.wsOpcaoComunicacao)) cfg.wsOpcaoComunicacao = 2;
  const ret = Number(cfg.retencaoSnapshots);
  cfg.retencaoSnapshots = Number.isFinite(ret) ? Math.max(1, Math.min(50, Math.floor(ret))) : 5;
  cfg.evidenciaEstrategia = cfg.evidenciaEstrategia
    ? String(cfg.evidenciaEstrategia).toUpperCase()
    : "ARQUIVO_RENOMEADO_BAK";
  cfg.arquivoGatilhoConfig =
    cfg.arquivoGatilhoConfig == null ? "" : String(cfg.arquivoGatilhoConfig).trim();

  if (cfg.enabled && !cfg.gerenciadorId) {
    throw new Error(
      "gerenciadorId é obrigatório quando enabled=true. Informe o UUID do gerenciador no backend.",
    );
  }
  if (cfg.enabled && cfg.modoEntrega === "WS_MGV7" && !cfg.modoSombra && !cfg.wsBaseUrl) {
    throw new Error(
      "wsBaseUrl é obrigatória quando modoEntrega=WS_MGV7 e modoSombra=false.",
    );
  }
  const pastaObrigatoria =
    cfg.modoEntrega === "PASTA"
    || cfg.modoEntrega === "PASTA_MONITORADA"
    || cfg.modoEntrega === "PASTA_GATILHO_POR_DATA";
  if (cfg.enabled && pastaObrigatoria && !cfg.modoSombra && !cfg.pastaCarga) {
    throw new Error(
      "pastaCarga é obrigatória quando enabled=true, entrega por pasta e modoSombra=false.",
    );
  }
  if (
    cfg.gerenciadorId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      cfg.gerenciadorId,
    )
  ) {
    throw new Error("gerenciadorId deve ser um UUID válido.");
  }
  return cfg;
}

function ler() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return validar(raw);
  } catch (err) {
    log.warn({ err: err.message, file }, "Falha ao ler/validar balanca-carga.json — usando defaults");
    return { ...DEFAULTS };
  }
}

function salvar(parcial) {
  const atual = ler();
  const merged = validar({ ...atual, ...parcial, schemaVersion: SCHEMA_VERSION });
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return merged;
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULTS,
  configPath,
  auditDir,
  validar,
  ler,
  salvar,
};
