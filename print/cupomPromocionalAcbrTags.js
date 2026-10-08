/**
 * Cupom promocional impresso (código + QR do link de resgate) — tags ACBr.
 * Não fiscal; não leva dados de cliente (pode ser entregue a qualquer pessoa).
 */
const { toThermalText } = require("../thermalText");
const { tagLogoHeader, tagCorte, tagQrCode } = require("./acbrTags");
const { sepEq, sepDash, getThermalCols } = require("./thermalCols");
const { linhasCabecalhoEmpresaTags } = require("./empresaCabecalhoTermico");

const CODIGO_RE = /^[A-Z0-9_-]{3,40}$/;
const LINK_MAX = 300;

function tx(v) {
  return toThermalText(v);
}

/** Só http(s) e sem caracteres que quebram as tags do POS_Imprimir. */
function linkSeguro(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > LINK_MAX) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  if (/[|<>'"\s]/.test(s)) return "";
  return s;
}

function quebrar(texto, cols) {
  const palavras = tx(texto).split(/\s+/).filter(Boolean);
  const out = [];
  let linha = "";
  for (const p of palavras) {
    const cand = linha ? linha + " " + p : p;
    if (cand.length > cols && linha) {
      out.push(linha);
      linha = p.slice(0, cols);
    } else {
      linha = cand.slice(0, cols);
    }
  }
  if (linha) out.push(linha);
  return out.slice(0, 6);
}

function normalizarCupomPromocionalPayload(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const codigo = String(p.codigo || "").trim().toUpperCase();
  const copias = Math.min(Math.max(parseInt(p.copias, 10) || 1, 1), 50);
  return {
    naoFiscal: true,
    cupomSemFiscal: true,
    codigo: CODIGO_RE.test(codigo) ? codigo : "",
    nome: String(p.nome || "").trim().slice(0, 80),
    regra: String(p.regra || p.descricao || "").trim().slice(0, 240),
    validade: String(p.validade || "").trim().slice(0, 40),
    link: linkSeguro(p.link),
    empresa: p.empresa && typeof p.empresa === "object" ? p.empresa : null,
    logo: p.logo,
    copias,
    clickId: String(p.clickId || p.click_id || "").trim().slice(0, 80),
  };
}

function renderUmaVia(payload, COLS) {
  const lines = [tagLogoHeader(payload)];
  lines.push(...linhasCabecalhoEmpresaTags(payload.empresa, COLS));
  lines.push(sepEq(), "<ce><n>CUPOM DE DESCONTO</n></ce>");
  if (payload.nome) lines.push(`<ce>${tx(payload.nome).slice(0, COLS)}</ce>`);
  lines.push(sepDash());
  for (const l of quebrar(payload.regra, COLS)) {
    lines.push(`<ce>${l}</ce>`);
  }
  lines.push("<ce>Use o codigo:</ce>", `<ce><e><n>${tx(payload.codigo)}</n></e></ce>`);
  if (payload.link) {
    lines.push("<ce>" + tagQrCode(payload.link) + "</ce>", "<ce>Aponte a camera para pedir</ce>");
  }
  if (payload.validade) lines.push(`<ce>Valido ate ${tx(payload.validade)}</ce>`);
  lines.push(
    sepEq(),
    "<ce>Apresente no caixa ou digite no cardapio</ce>",
    "<ce>Documento nao fiscal</ce>",
    tagCorte(),
  );
  return lines;
}

function renderCupomPromocionalTags(rawPayload = {}) {
  const payload = normalizarCupomPromocionalPayload(rawPayload);
  const COLS = getThermalCols();
  const lines = ["</zera>"];
  for (let i = 0; i < payload.copias; i++) {
    lines.push(...renderUmaVia(payload, COLS));
  }
  return lines.filter(Boolean).join("\n") + "\n";
}

module.exports = {
  normalizarCupomPromocionalPayload,
  renderCupomPromocionalTags,
  linkSeguro,
  quebrar,
};
