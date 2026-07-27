/**
 * Largura térmica (colunas fonte A) — fonte única para 58mm / 80mm.
 *
 * Convenção:
 *   80mm → 48 colunas (padrão, mais usado)
 *   58mm → 32 colunas
 *
 * Layouts devem ler getThermalCols() em tempo de render — nunca hardcode 48.
 */
const COLS_80MM = 48;
const COLS_58MM = 32;
const COLS_MIN = 24;
const COLS_MAX = 64;
/** Abaixo disso o layout de itens usa 2 linhas (nome + valores). */
const COLS_TABELA_ITENS_MIN = 42;

function clampCols(n) {
  const v = parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return null;
  return Math.min(COLS_MAX, Math.max(COLS_MIN, v));
}

/** Mapeia milímetros de bobina → colunas fonte A. */
function paperMmToCols(mm) {
  return Number(mm) === 58 ? COLS_58MM : COLS_80MM;
}

/**
 * Resolve colunas ativas: config local → env → 80mm (48).
 * @returns {number}
 */
function getThermalCols() {
  try {
    const cfg = require("./printerLocalConfig").ler();
    const fromCfg = clampCols(cfg.colunas);
    if (fromCfg != null) return fromCfg;
  } catch {
    /* config indisponível no boot de teste */
  }
  const fromEnv = clampCols(process.env.PRINTER_COLUNAS);
  if (fromEnv != null) return fromEnv;
  const mm = parseInt(String(process.env.PRINTER_PAPER_MM || ""), 10);
  if (mm === 58 || mm === 80) return paperMmToCols(mm);
  return COLS_80MM;
}

function isNarrowThermal(cols = getThermalCols()) {
  return cols < COLS_TABELA_ITENS_MIN;
}

function sepEq(cols = getThermalCols()) {
  return "=".repeat(cols);
}

function sepDash(cols = getThermalCols()) {
  return "-".repeat(cols);
}

function padR(txt, len) {
  return String(txt ?? "").slice(0, len).padEnd(len);
}

function padL(txt, len) {
  return String(txt ?? "").slice(0, len).padStart(len);
}

function col2(esq, dir, cols = getThermalCols()) {
  const e = String(esq ?? "");
  const d = String(dir ?? "");
  const esp = Math.max(1, cols - e.length - d.length);
  return e + " ".repeat(esp) + d;
}

/**
 * Chave NFC-e (44 dígitos) em linhas que cabem na bobina.
 * @param {string} chave
 * @param {number} [cols]
 * @returns {string[]}
 */
function formatChaveLines(chave, cols = getThermalCols()) {
  const digits = String(chave || "").replace(/\D/g, "");
  if (!digits) return [];
  const grupos = digits.match(/.{1,4}/g) || [digits];
  const joined = grupos.join(" ");
  if (joined.length <= cols) return [joined];
  // Empacota grupos sem estourar a linha.
  const lines = [];
  let cur = "";
  for (const g of grupos) {
    const next = cur ? `${cur} ${g}` : g;
    if (next.length <= cols) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = g;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Linhas de item do cupom — 80mm (tabela) ou 58mm (nome + valores).
 * @returns {string[]}
 */
function buildCupomItemLines(opts) {
  const cols = opts.cols ?? getThermalCols();
  const idx = opts.idx ?? 0;
  const nome = String(opts.nome || "");
  const valUnit = String(opts.valUnit || "");
  const valTotal = String(opts.valTotal || "");
  const num = String(idx + 1).padStart(2, "0");

  if (!isNarrowThermal(cols)) {
    // 80mm: DESCRICAO(26) + UNIT(8) + TOTAL(8) = 42
    return [num + " " + padR(nome, 23) + padL(valUnit, 9) + padL(valTotal, 9)];
  }

  // 58mm: nome na 1ª linha; unit/total na 2ª.
  const nameBudget = Math.max(8, cols - 3);
  const lines = [`${num} ${nome.slice(0, nameBudget)}`];
  lines.push(col2(`  ${valUnit}`, valTotal, cols));
  return lines;
}

function buildCupomItemHeader(cols = getThermalCols()) {
  if (!isNarrowThermal(cols)) {
    return padR("DESCRICAO", 26) + padL("UNIT", 8) + padL("TOTAL", 8);
  }
  return col2("ITEM", "TOTAL", cols);
}

/** Sugestão de módulo QR ESC/POS / BMP conforme largura. */
function suggestQrModuleSize(cols = getThermalCols()) {
  return isNarrowThermal(cols) ? 4 : 6;
}

function suggestQrBmpWidth(cols = getThermalCols()) {
  return isNarrowThermal(cols) ? 180 : 280;
}

module.exports = {
  COLS_80MM,
  COLS_58MM,
  COLS_TABELA_ITENS_MIN,
  clampCols,
  paperMmToCols,
  getThermalCols,
  isNarrowThermal,
  sepEq,
  sepDash,
  padR,
  padL,
  col2,
  formatChaveLines,
  buildCupomItemLines,
  buildCupomItemHeader,
  suggestQrModuleSize,
  suggestQrBmpWidth,
};
