/**
 * DANFE térmico simplificado (NF-e modelo 55) — layout via tags ACBr.
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const {
  tagQrCode,
  tagBarcode,
  tagLogoHeader,
  tagSegundaViaBanner,
  tagCorte,
  tagBarcodesList,
} = require("./acbrTags");
const { resolverQrCodeNfce } = require("./cupomValidate");

const COLS = 48;

function sep(c) {
  return String(c).repeat(COLS);
}
function col2(a, b) {
  const e = String(a);
  const d = String(b);
  return e + " ".repeat(Math.max(1, COLS - e.length - d.length)) + d;
}

/**
 * @param {object} payload
 * @returns {string}
 */
function renderDanfeTermicoTags(payload) {
  const empresa = payload.empresa || {};
  const dest = payload.destinatario || {};
  const lines = [];

  lines.push("</zera>");
  const logo = tagLogoHeader();
  if (logo) lines.push(logo);
  if (payload.segundaVia) lines.push(tagSegundaViaBanner());

  lines.push("<ce><n>DANFE SIMPLIFICADO NF-e</n></ce>");
  lines.push("<ce>Documento Auxiliar — via térmica</ce>");
  lines.push(sep("="));

  const nome = toThermalText(empresa.nomeFantasia || empresa.razaoSocial || "EMITENTE");
  lines.push(`<ce><n>${nome.toUpperCase()}</n></ce>`);
  if (empresa.cnpj) lines.push(`CNPJ: ${toThermalDoc(empresa.cnpj)}`);
  lines.push(sep("-"));

  lines.push(col2("Venda:", payload.numeroVenda || ""));
  if (payload.numeroNfe) {
    lines.push(col2("NF-e:", `${payload.numeroNfe}  Serie: ${payload.serieNfe || "1"}`));
  }
  if (payload.protocolo) lines.push(`Protocolo: ${String(payload.protocolo).slice(0, 36)}`);

  if (dest.razaoSocial || dest.nome) {
    lines.push(sep("-"));
    lines.push("DESTINATARIO:");
    lines.push(toThermalText(dest.razaoSocial || dest.nome || "").slice(0, COLS));
    if (dest.cpfCnpj) lines.push(toThermalDoc(dest.cpfCnpj));
  }

  const itens = payload.itens || [];
  if (itens.length) {
    lines.push(sep("-"));
    lines.push("ITENS (resumo):");
    itens.slice(0, 15).forEach((it, i) => {
      const nomeItem = toThermalText(String(it.nome || "")).slice(0, 28);
      const total = Number(it.total ?? it.precoUnitario * it.quantidade).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      lines.push(`${String(i + 1).padStart(2, "0")} ${nomeItem} ${total}`);
    });
    if (itens.length > 15) lines.push(`... +${itens.length - 15} item(ns)`);
  }

  const total = Number(payload.total || 0);
  lines.push(sep("="));
  lines.push(`<ce><n>TOTAL NF-e: R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</n></ce>`);
  lines.push(sep("="));

  const chave = String(payload.chaveNfe || payload.chave || "").replace(/\D/g, "");
  if (chave.length === 44) {
    lines.push("Chave de acesso:");
    for (let i = 0; i < 44; i += 4) lines.push(chave.slice(i, i + 4));
    const bc = tagBarcode("CODE128", chave, { altura: 40, largura: 2, exibeCodigo: false });
    if (bc) lines.push(bc);
  }

  const qr = resolverQrCodeNfce(payload);
  if (qr) {
    lines.push("</linha_simples>");
    lines.push("<ce>Consulta NF-e — QR Code</ce>");
    lines.push(tagQrCode(qr));
  }

  const extras = tagBarcodesList(payload.barcodes);
  extras.forEach((t) => lines.push(t));

  lines.push("</linha_simples>");
  lines.push("<ce>Consulte NF-e completa em PDF no painel</ce>");
  lines.push(tagCorte());

  return lines.join("\n") + "\n";
}

module.exports = {
  renderDanfeTermicoTags,
  COLS,
};
