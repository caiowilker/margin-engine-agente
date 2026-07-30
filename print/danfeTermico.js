/**
 * DANFE térmico simplificado (NF-e modelo 55) — layout via tags ACBr.
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const {
  tagQrCodeSeguro,
  tagBarcode,
  tagLogoHeader,
  tagSegundaViaBanner,
  tagCorte,
  tagBarcodesList,
} = require("./acbrTags");
const { ceCorpo } = require("./cupomContraste");
const { resolverQrCodeNfce } = require("./cupomValidate");
const {
  getThermalCols,
  sepEq,
  sepDash,
  col2,
  formatChaveLines,
} = require("./thermalCols");

/**
 * @param {object} payload
 * @returns {string}
 */
function renderDanfeTermicoTags(payload) {
  const COLS = getThermalCols();
  const empresa = payload.empresa || {};
  const dest = payload.destinatario || {};
  const lines = [];

  lines.push("</zera>");
  const logo = tagLogoHeader(payload);
  if (logo) lines.push(logo);
  if (require("./segundaVia").deveExibirBannerSegundaVia(payload)) lines.push(tagSegundaViaBanner());

  lines.push("<ce><n>DANFE SIMPLIFICADO NF-e</n></ce>");
  lines.push("<ce>Documento Auxiliar — via térmica</ce>");
  lines.push(sepEq());

  const nome = toThermalText(empresa.nomeFantasia || empresa.razaoSocial || "ESTABELECIMENTO");
  lines.push(`<ce><n>${nome.toUpperCase()}</n></ce>`);
  if (empresa.cnpj) lines.push(`CNPJ: ${toThermalDoc(empresa.cnpj)}`);
  if (empresa.inscricaoEstadual) {
    lines.push(`IE: ${toThermalDoc(empresa.inscricaoEstadual)}`);
  }
  lines.push(sepDash());

  lines.push(col2("Venda:", payload.numeroVenda || ""));
  if (payload.numeroNfe) {
    lines.push(col2("NF-e:", `${payload.numeroNfe}  Serie: ${payload.serieNfe || "1"}`));
  }
  if (payload.protocolo) lines.push(`Protocolo: ${String(payload.protocolo).slice(0, Math.min(36, COLS))}`);

  if (dest.razaoSocial || dest.nome) {
    lines.push(sepDash());
    lines.push("DESTINATARIO:");
    lines.push(toThermalText(dest.razaoSocial || dest.nome || "").slice(0, COLS));
    if (dest.cpfCnpj) lines.push(toThermalDoc(dest.cpfCnpj));
  }

  const itens = payload.itens || [];
  if (itens.length) {
    lines.push(sepDash());
    lines.push("ITENS (resumo):");
    itens.slice(0, 15).forEach((it, i) => {
      const nomeItem = toThermalText(String(it.nome || "")).slice(0, Math.max(12, COLS - 12));
      const total = Number(it.total ?? it.precoUnitario * it.quantidade).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      lines.push(`${String(i + 1).padStart(2, "0")} ${nomeItem}`.slice(0, COLS));
      lines.push(col2("  ", total, COLS));
    });
    if (itens.length > 15) lines.push(`... +${itens.length - 15} item(ns)`);
  }

  const total = Number(payload.total || 0);
  lines.push(sepEq());
  lines.push(`<ce><n>TOTAL NF-e: R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</n></ce>`);
  lines.push(sepEq());

  const chave = String(payload.chaveNfe || payload.chave || "").replace(/\D/g, "");
  if (chave.length === 44) {
    lines.push("</linha_simples>");
    lines.push(ceCorpo("Chave de acesso"));
    for (const line of formatChaveLines(chave, COLS)) {
      lines.push(ceCorpo(line));
    }
    const bc = tagBarcode("CODE128", chave, { altura: 40, largura: 2, exibeCodigo: false });
    if (bc) lines.push(bc);
  }

  const qr = resolverQrCodeNfce(payload);
  if (qr) {
    lines.push("</linha_simples>");
    lines.push(ceCorpo("Consulta NF-e — QR Code"));
    lines.push(tagQrCodeSeguro(qr));
    lines.push("</linha_simples>");
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
  getThermalCols,
};
