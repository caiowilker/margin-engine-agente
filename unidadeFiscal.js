/**
 * Normalização de unidades para documentos fiscais (NFC-e / NF-e).
 * Espelha com.marginengine.retail.unit.UnidadeFiscal no backend.
 */

const SEFAZ = new Set([
  "UN", "KG", "G", "L", "ML", "CX", "FD", "PCT", "M", "M2", "M3", "DZ", "PC", "MT", "LT",
]);

function normalizarCodigoUnidade(unidade) {
  if (!unidade || String(unidade).trim() === "") return null;
  const u = String(unidade).trim().toLowerCase();
  switch (u) {
    case "un":
    case "und":
    case "uni":
    case "unidade":
    case "pc":
    case "pç":
    case "peca":
    case "peça":
      return "UN";
    case "kg":
    case "quilo":
    case "quilograma":
      return "KG";
    case "g":
    case "gr":
    case "grama":
    case "gramas":
      return "G";
    case "l":
    case "lt":
    case "litro":
    case "litros":
      return "L";
    case "ml":
    case "mililitro":
    case "mililitros":
      return "ML";
    case "cx":
    case "caixa":
    case "caixas":
      return "CX";
    case "fd":
    case "fardo":
      return "FD";
    case "pct":
    case "pac":
    case "pacote":
      return "PCT";
    case "m":
    case "mt":
    case "metro":
    case "metros":
      return "M";
    case "m2":
    case "m²":
      return "M2";
    case "m3":
    case "m³":
      return "M3";
    case "dz":
    case "duzia":
    case "dúzia":
      return "DZ";
    default: {
      const up = String(unidade).trim().toUpperCase();
      if (up === "LT") return "L";
      if (SEFAZ.has(up)) return up;
      return null;
    }
  }
}

/**
 * @param {string | null | undefined} unidade
 * @param {boolean} [porPeso]
 * @returns {string}
 */
function resolverUnidadeFiscal(unidade, porPeso = false) {
  if (porPeso) {
    const norm = normalizarCodigoUnidade(unidade);
    if (norm === "G" || norm === "ML") return norm;
    return "KG";
  }
  return normalizarCodigoUnidade(unidade) ?? "UN";
}

/**
 * @param {{ unidade?: string | null, porPeso?: boolean }} item
 * @returns {string}
 */
function unidadeFiscalDoItem(item) {
  return resolverUnidadeFiscal(item?.unidade, item?.porPeso);
}

module.exports = {
  resolverUnidadeFiscal,
  normalizarCodigoUnidade,
  unidadeFiscalDoItem,
};
