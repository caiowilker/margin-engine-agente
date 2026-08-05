/**
 * Política única de tamanho da logo térmica (cupom / caixa / pedido).
 *
 * ACBr (KC): fatorX/fatorY 1–4
 * ACBr (BMP arquivo): atributo Largura em dots
 * ESC/POS nativo: resize antes de image()
 */
const { getThermalCols, isNarrowThermal } = require("./thermalCols");

const FATOR_MIN = 1;
const FATOR_MAX = 4;
/** Padrão comercial — logo bem visível no cabeçalho (antes era 1). */
const FATOR_PADRAO = 2;

function clampFator(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < FATOR_MIN) return FATOR_PADRAO;
  return Math.min(FATOR_MAX, Math.max(FATOR_MIN, Math.round(n)));
}

/**
 * Resolve fator de escala. Env vence; meta ≤1 (legado) promove para FATOR_PADRAO.
 */
function resolveLogoFator(meta = {}) {
  const envX = process.env.PRINTER_LOGO_FATORX;
  if (envX != null && String(envX).trim() !== "") {
    const fx = clampFator(envX);
    const fy = clampFator(
      process.env.PRINTER_LOGO_FATORY != null &&
        String(process.env.PRINTER_LOGO_FATORY).trim() !== ""
        ? process.env.PRINTER_LOGO_FATORY
        : fx,
    );
    return { fatorX: String(fx), fatorY: String(fy), fator: fx };
  }

  const metaX = Number(meta.fatorX);
  const fx =
    !Number.isFinite(metaX) || metaX <= 1 ? FATOR_PADRAO : clampFator(metaX);
  const metaY = Number(meta.fatorY);
  const fy =
    !Number.isFinite(metaY) || metaY <= 1 ? fx : clampFator(metaY);
  return { fatorX: String(fx), fatorY: String(fy), fator: fx };
}

/**
 * Largura alvo em dots (~8 dots por coluna fonte A).
 * 80mm ≈ 360–480; 58mm ≈ 200–280 — cabe no papel sem cortar.
 */
function resolveLogoBmpLargura(cols = getThermalCols(), fator = FATOR_PADRAO) {
  const f = clampFator(fator);
  const base = isNarrowThermal(cols) ? 228 : 384;
  // f1≈0.78× · f2=1× · f3≈1.18× · f4≈1.35×
  const mult = 0.6 + f * 0.2;
  const maxDots = Math.max(160, cols * 8 - 16);
  // Cap para não estourar soft timeout do worker ACBr (~5s) em USB lento.
  const hardCap = Math.min(
    480,
    Math.max(160, Number(process.env.PRINTER_LOGO_MAX_WIDTH_DOTS || 384) || 384),
  );
  return Math.min(hardCap, maxDots, Math.round(base * mult));
}

/** Tamanho efetivo para todos os drivers de impressão. */
function resolveLogoPrintSize(meta = {}) {
  const { fatorX, fatorY, fator } = resolveLogoFator(meta);
  const cols = getThermalCols();
  const bmpLargura = resolveLogoBmpLargura(cols, fator);
  return {
    fatorX,
    fatorY,
    fator,
    cols,
    narrow: isNarrowThermal(cols),
    bmpLargura,
    escposWidthDots: bmpLargura,
    density: "d24",
  };
}

module.exports = {
  FATOR_MIN,
  FATOR_MAX,
  FATOR_PADRAO,
  clampFator,
  resolveLogoFator,
  resolveLogoBmpLargura,
  resolveLogoPrintSize,
};
