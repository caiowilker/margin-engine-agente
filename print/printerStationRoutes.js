/**
 * Rotas de impressora por estação (printType → porta ACBr).
 * Permite 2+ impressoras no mesmo PC: cozinha e bar em portas distintas,
 * sem precisar de um agente por máquina.
 *
 * Arquivo: data/printer-stations.json
 * Porta vazia = usa a impressora padrão (PosPrinter.Porta).
 */
const fs = require("fs");
const path = require("path");
const log = require("../logger").child({ modulo: "printer_station_routes" });
const { normalizarPortaAcbr, portaAcbrValida } = require("./printerModelMap");

const AGENT_ROOT = path.resolve(__dirname, "..");
const PRINT_TYPES = ["cozinha", "bar", "producao", "cliente", "entrega"];

/** @type {string | null} */
let portaOverride = null;

function resolveFilePath() {
  if (process.env.PRINTER_STATIONS_FILE) {
    return process.env.PRINTER_STATIONS_FILE;
  }
  return path.join(AGENT_ROOT, "data", "printer-stations.json");
}

function emptyRoutes() {
  return {
    byPrintType: {
      cozinha: "",
      bar: "",
      producao: "",
      cliente: "",
      entrega: "",
    },
  };
}

function normalizeRoutes(raw) {
  const base = emptyRoutes();
  const incoming =
    raw && typeof raw === "object" && raw.byPrintType && typeof raw.byPrintType === "object"
      ? raw.byPrintType
      : raw && typeof raw === "object"
        ? raw
        : {};
  for (const type of PRINT_TYPES) {
    const val = incoming[type];
    base.byPrintType[type] = val != null && String(val).trim() ? String(val).trim() : "";
  }
  return base;
}

function ler() {
  const file = resolveFilePath();
  if (!fs.existsSync(file)) return emptyRoutes();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizeRoutes(raw);
  } catch (err) {
    log.warn({ err: err.message, file }, "[PrinterStations] JSON inválido — usando vazio");
    return emptyRoutes();
  }
}

function salvar(updates) {
  const current = ler();
  const incoming =
    updates && typeof updates === "object" && updates.byPrintType && typeof updates.byPrintType === "object"
      ? updates.byPrintType
      : updates && typeof updates === "object"
        ? updates
        : {};
  const merged = {
    byPrintType: {
      ...current.byPrintType,
      ...Object.fromEntries(
        Object.entries(incoming).map(([k, v]) => [k, v != null ? String(v).trim() : ""]),
      ),
    },
  };
  const next = normalizeRoutes(merged);
  for (const type of PRINT_TYPES) {
    const porta = next.byPrintType[type];
    if (!porta) continue;
    const normalizada = normalizarPortaAcbr(porta, {});
    if (!portaAcbrValida(normalizada)) {
      throw new Error(`Porta inválida para ${type}: ${porta}`);
    }
    next.byPrintType[type] = normalizada;
  }
  const file = resolveFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  log.info({ file, routes: next.byPrintType }, "[PrinterStations] Rotas salvas");
  return next;
}

function resolvePortaForPrintType(printType) {
  const type = String(printType || "").trim().toLowerCase();
  if (!type) return null;
  const routes = ler();
  const porta = routes.byPrintType[type];
  return porta && portaAcbrValida(porta) ? porta : null;
}

function hasAnyStationRoute() {
  const routes = ler();
  return PRINT_TYPES.some((t) => Boolean(routes.byPrintType[t]));
}

function getPortaOverride() {
  return portaOverride;
}

/**
 * Executa fn com porta ACBr temporária (ex.: job de bar neste PC).
 * Invalida a sessão ACBr antes/depois para forçar reativação na porta certa.
 */
async function withPortaOverride(porta, fn) {
  if (!porta || !portaAcbrValida(porta)) {
    return fn();
  }
  const prev = portaOverride;
  portaOverride = porta;
  try {
    try {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
    } catch (_) {
      /* sessão ainda não existia */
    }
    return await fn();
  } finally {
    portaOverride = prev;
    try {
      await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  PRINT_TYPES,
  ler,
  salvar,
  resolvePortaForPrintType,
  hasAnyStationRoute,
  getPortaOverride,
  withPortaOverride,
  resolveFilePath,
  emptyRoutes,
};
