/**
 * Comprovante não fiscal de empréstimo de vasilhame (caução) — tags ACBr.
 * Isolado de cupom fiscal / pedido / caixa (mesmo padrão de pedidoAcbrTags.js).
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const {
  tagLogoHeader,
  tagCorte,
  tagBarcode,
  tagSegundaViaBanner,
} = require("./acbrTags");
const { sepEq, sepDash, getThermalCols } = require("./thermalCols");
const { deveExibirBannerSegundaVia } = require("./segundaVia");

function tx(v) {
  return toThermalText(v);
}

function fmtR$(cents) {
  const n = Number(cents || 0) / 100;
  return (
    "R$ " +
    n.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function normalizarVasilhamePayload(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const codigo = String(p.codigoTransacao || p.codigo || "").trim().toUpperCase();
  const clickId = String(p.clickId || p.click_id || "").trim();
  const motivo = String(p.motivo || "").trim();
  const reimpressao =
    p.reimpressao === true ||
    clickId.length > 0 ||
    /reimpress|segunda/.test(motivo.toLowerCase());
  return {
    ...p,
    naoFiscal: true,
    cupomSemFiscal: true,
    codigoTransacao: codigo,
    tipoNome: p.tipoNome || p.tipo || "",
    tipoCodigo: p.tipoCodigo || "",
    clienteNome: p.clienteNome || p.cliente || "",
    quantidade: p.quantidade != null ? Number(p.quantidade) : null,
    caucaoCents: p.caucaoCents != null ? Number(p.caucaoCents) : 0,
    dataMovimento: p.dataMovimento || p.data || "",
    dataPrevistaDevolucao: p.dataPrevistaDevolucao || p.prevista || "",
    operador: p.operador || "",
    observacao: p.observacao || "",
    empresa: p.empresa || null,
    reimpressao,
    clickId,
    motivo: reimpressao
      ? motivo || "reimpressao_vasilhame"
      : motivo,
  };
}

function renderVasilhameTags(rawPayload = {}) {
  const payload = normalizarVasilhamePayload(rawPayload);
  const COLS = getThermalCols();
  const lines = ["</zera>", tagLogoHeader(payload)];

  if (deveExibirBannerSegundaVia(payload)) {
    lines.push(tagSegundaViaBanner());
  }

  if (payload.empresa?.nome) {
    lines.push(`<ce><n>${tx(payload.empresa.nome)}</n></ce>`);
  }
  if (payload.empresa?.cnpj) {
    lines.push(`CNPJ: ${toThermalDoc(payload.empresa.cnpj)}`);
  }

  lines.push(
    sepEq(),
    "<ce><n>EMPRESTIMO DE VASILHAME</n></ce>",
    "<ce>Comprovante nao fiscal</ce>",
    sepEq(),
  );

  if (payload.clienteNome) {
    lines.push(`Cliente : ${tx(payload.clienteNome)}`);
  }
  if (payload.tipoNome || payload.tipoCodigo) {
    const tipo = [payload.tipoNome, payload.tipoCodigo ? `(${payload.tipoCodigo})` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`Tipo    : ${tx(tipo)}`);
  }
  if (payload.quantidade != null && !Number.isNaN(payload.quantidade)) {
    lines.push(`Qtde    : ${payload.quantidade}`);
  }
  if (payload.dataMovimento) {
    lines.push(`Saida   : ${tx(payload.dataMovimento)}`);
  }
  if (payload.dataPrevistaDevolucao) {
    lines.push(`Prevista: ${tx(payload.dataPrevistaDevolucao)}`);
  }
  if (payload.operador) {
    lines.push(`Operador: ${tx(payload.operador)}`);
  }

  lines.push(sepDash());
  if (payload.caucaoCents > 0) {
    lines.push(`<n>Caucao retida: ${fmtR$(payload.caucaoCents)}</n>`);
  } else {
    lines.push("Caucao: sem cobranca");
  }

  if (payload.observacao) {
    lines.push(sepDash(), `Obs: ${tx(payload.observacao).slice(0, COLS)}`);
  }

  if (payload.codigoTransacao) {
    // Uma só simbologia CODE128 + texto legível (sem dual CODE39 / QR).
    lines.push(
      sepEq(),
      "<ce><n>ETIQUETA - COLE NO VASILHAME</n></ce>",
      `<ce><e><n>${tx(payload.codigoTransacao)}</n></e></ce>`,
      "<ce>Apresente na devolucao</ce>",
    );
    const bc = tagBarcode("CODE128", payload.codigoTransacao, {
      altura: 64,
      largura: 2,
      exibeCodigo: true,
    });
    if (bc) lines.push("<ce>" + bc + "</ce>");
    lines.push(`<ce><n>${tx(payload.codigoTransacao)}</n></ce>`);
  }

  lines.push(
    sepEq(),
    "<ce>Documento nao fiscal</ce>",
    "<ce>Nao substitui NFC-e / cupom fiscal</ce>",
    tagCorte(),
  );
  return lines.filter(Boolean).join("\n") + "\n";
}

module.exports = {
  normalizarVasilhamePayload,
  renderVasilhameTags,
};
