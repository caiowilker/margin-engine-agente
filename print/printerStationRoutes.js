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
      const err = new Error(`Porta inválida para ${type}: ${porta}`);
      err.code = "PRINTER_PORTA_INVALIDA";
      throw err;
    }
    next.byPrintType[type] = normalizada;
  }

  const unchanged = PRINT_TYPES.every(
    (t) => String(current.byPrintType[t] || "") === String(next.byPrintType[t] || ""),
  );
  if (unchanged) {
    log.debug({ routes: next.byPrintType }, "[PrinterStations] Sem mudança — skip save");
    return Object.assign(next, { unchanged: true });
  }

  const file = resolveFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
  log.info({ file, routes: next.byPrintType }, "[PrinterStations] Rotas salvas");
  return Object.assign(next, { unchanged: false });
}

function resolvePortaForPrintType(printType) {
  const type = String(printType || "").trim().toLowerCase();
  if (!type) return null;
  const routes = ler();
  const porta = routes.byPrintType[type];
  return porta && portaAcbrValida(porta) ? porta : null;
}

/**
 * Tipos de comanda de estação: com rotas parciais, exigem porta explícita.
 * Sem nenhuma rota → null (impressora padrão). Cliente/cupom pode cair no padrão.
 */
const STATION_TYPES_REQUIRING_ROUTE = ["cozinha", "bar", "producao", "entrega"];

function requirePortaForPrintType(printType) {
  const type = String(printType || "").trim().toLowerCase();
  const porta = resolvePortaForPrintType(type);
  if (porta) return porta;
  if (!type || !hasAnyStationRoute()) return null;
  if (!STATION_TYPES_REQUIRING_ROUTE.includes(type)) return null;
  const err = new Error(
    `Categoria ${type} sem impressora em Rotas — configure em ` +
      `Configurações → Impressora → Rotas (com outras rotas preenchidas, ` +
      `não dá para usar só a impressora padrão nesta categoria).`,
  );
  err.code = "PRINTER_STATION_ROUTE_MISSING";
  throw err;
}

function hasAnyStationRoute() {
  const routes = ler();
  return PRINT_TYPES.some((t) => Boolean(routes.byPrintType[t]));
}

function getPortaOverride() {
  return portaOverride;
}

/**
 * Executa fn com porta temporária (ex.: job de bar neste PC).
 *
 * NÃO invalida PosPrinter a cada pedido (Desativar×2 em RAW travava o spooler).
 * A porta entra em buildRuntimeValues() via getPortaOverride(); o worker
 * re-Ativa só quando o JSON de values muda (troca de porta).
 *
 * opts.invalidateAcbr permanece aceito por compatibilidade, mas é ignorado
 * (salvo ACBR_POS_STATION_INVALIDATE=true — legado/diagnóstico).
 */
async function withPortaOverride(porta, fn, opts = {}) {
  if (!porta || !portaAcbrValida(porta)) {
    return fn();
  }
  const prev = portaOverride;
  portaOverride = porta;
  const forceInvalidate =
    opts.invalidateAcbr === true &&
    String(process.env.ACBR_POS_STATION_INVALIDATE || "").toLowerCase() === "true";
  try {
    if (forceInvalidate) {
      try {
        await require("./acbrPosPrinterRuntime").invalidatePosPrinterSession();
      } catch (_) {
        /* sessão ainda não existia */
      }
    }
    return await fn();
  } finally {
    portaOverride = prev;
    // Sem invalidate no finally — preserva sessão quente para o próximo cupom.
  }
}

module.exports = {
  PRINT_TYPES,
  STATION_TYPES_REQUIRING_ROUTE,
  ler,
  salvar,
  resolvePortaForPrintType,
  requirePortaForPrintType,
  hasAnyStationRoute,
  getPortaOverride,
  withPortaOverride,
  resolveFilePath,
  emptyRoutes,
};
