/**
 * Contraste do cupom térmico ACBr — modelo 0 (ppTexto/RAW Windows) imprime mais escuro
 * em fonte normal. Negrito simulado em quase todas as linhas costuma sair "apagado".
 *
 * Paridade com print/escpos/impressoraCore.js: corpo normal, negrito só em destaques.
 */
function modoContraste() {
  const env = String(process.env.PRINTER_CUPOM_CONTRASTE || "").trim().toLowerCase();
  if (env === "alto" || env === "escuro" || env === "dark") return "alto";
  if (env === "normal" || env === "negrito" || env === "bold") return "normal";

  let modelo = "0";
  try {
    modelo = String(require("./printerLocalConfig").ler()?.modelo || process.env.PRINTER_MODEL || "0");
  } catch (_) {}

  // Modelo 0 = ppTexto genérico — negrito simulado tende a ficar claro no spooler RAW.
  if (modelo === "0") return "alto";
  return "normal";
}

function stripTag(tag, texto) {
  const re = new RegExp(`</?${tag}>`, "gi");
  return String(texto ?? "").replace(re, "").trim();
}

/** Texto do corpo — fonte normal (mais escura em térmicas genéricas). */
function corpo(texto) {
  return String(texto ?? "");
}

/** Negrito pontual — títulos, total, troco. */
function destaque(texto) {
  const t = String(texto ?? "");
  if (!t) return "";
  if (/<\/?n>/i.test(t)) return t;
  return `<n>${t}</n>`;
}

/** Centralizado + negrito (ordem correta das tags ACBr). */
function ceDestaque(texto) {
  const t = stripTag("ce", texto);
  if (!t) return "";
  if (modoContraste() === "alto") return `<ce>${destaque(t)}</ce>`;
  return `<ce>${destaque(t)}</ce>`;
}

/** Cabeçalho da loja — único bloco com expandido + negrito. */
function cabecalhoLoja(texto) {
  const t = String(texto ?? "");
  if (!t) return "";
  return `<ce><e><n>${t}</n></e></ce>`;
}

/**
 * Linha de corpo com contraste configurável.
 * Modo alto: sempre normal. Modo normal: negrito (impressoras com firmware dedicado).
 */
function linhaCorpo(texto) {
  const t = String(texto ?? "");
  if (!t) return "";
  if (modoContraste() === "normal") return destaque(t);
  return corpo(t);
}

/** Centralizado corpo (rodapé, QR label). */
function ceCorpo(texto) {
  const t = stripTag("ce", texto);
  if (!t) return "";
  return `<ce>${linhaCorpo(t)}</ce>`;
}

module.exports = {
  modoContraste,
  corpo,
  destaque,
  ceDestaque,
  cabecalhoLoja,
  linhaCorpo,
  ceCorpo,
};
