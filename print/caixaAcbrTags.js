/**
 * Comprovantes de caixa em tags ACBr — mesma identidade visual do cupom (48 col).
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const { tagLogoHeader, tagCorte } = require("./acbrTags");

const COLS = 48;

function sepEq() {
  return "=".repeat(COLS);
}
function sepDash() {
  return "-".repeat(COLS);
}
function fmtR$(v) {
  return (
    "R$ " +
    Number(v || 0).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function tx(v) {
  return toThermalText(v);
}
function formatarLinhaEndereco(empresa) {
  const e = empresa || {};
  const log = (e.logradouro || "").trim();
  if (log) return tx([log, e.numero, e.bairro].filter(Boolean).join(", "));
  return e.endereco ? tx(String(e.endereco)) : "";
}

function renderAberturaTags(payload = {}) {
  const lines = ["</zera>", tagLogoHeader()];
  if (payload.empresa?.nome) {
    lines.push(`<ce><n>${tx(payload.empresa.nome)}</n></ce>`);
  }
  if (payload.empresa?.cnpj) {
    lines.push(`CNPJ: ${toThermalDoc(payload.empresa.cnpj)}`);
  }
  lines.push(
    sepEq(),
    "<ce><n>ABERTURA DE CAIXA</n></ce>",
    sepEq(),
    `Caixa   : ${payload.numeroCaixa || "Principal"}`,
    `Operador: ${tx(payload.operador || "-")}`,
    `Data/Hr : ${payload.aberturaEm || new Date().toLocaleString("pt-BR")}`,
    sepDash(),
    `<n>Fundo   : ${fmtR$(payload.valorAbertura || 0)}</n>`,
    sepEq(),
    tagCorte(),
  );
  return lines.filter(Boolean).join("\n") + "\n";
}

function renderFechamentoTags(payload = {}) {
  const lines = ["</zera>", tagLogoHeader()];
  lines.push(`<ce><n>${tx(payload.empresa?.nome || "PDV")}</n></ce>`);
  if (payload.empresa?.cnpj) {
    lines.push(`CNPJ: ${toThermalDoc(payload.empresa.cnpj)}`);
  }
  const end = formatarLinhaEndereco(payload.empresa);
  if (end) lines.push(end.slice(0, COLS));
  lines.push(
    sepEq(),
    "<ce><n>FECHAMENTO DE CAIXA</n></ce>",
    sepEq(),
    `Caixa   : ${payload.numeroCaixa || "Principal"}`,
    `Operador: ${tx(payload.operador || "-")}`,
    `Abertura: ${payload.aberturaEm || "-"}`,
    `Fecham. : ${payload.fechamentoEm || "-"}`,
  );
  if (payload.minutosAberto) {
    const h = Math.floor(payload.minutosAberto / 60);
    const m = payload.minutosAberto % 60;
    lines.push(`Tempo   : ${h > 0 ? `${h}h ` : ""}${String(m).padStart(2, "0")}min`);
  }
  if (payload.totais && typeof payload.totais === "object") {
    lines.push(sepDash(), "<n>RESUMO</n>");
    for (const [k, v] of Object.entries(payload.totais)) {
      lines.push(`${tx(k)}: ${fmtR$(v)}`);
    }
  }
  if (payload.valorFechamento != null) {
    lines.push(sepDash(), `<n>Total   : ${fmtR$(payload.valorFechamento)}</n>`);
  }
  lines.push(sepEq(), tagCorte());
  return lines.filter(Boolean).join("\n") + "\n";
}

function renderMovimentoCaixaTags(payload = {}) {
  const tipoLabel = payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";
  const lines = [
    "</zera>",
    tagLogoHeader(),
    `<ce><n>${tipoLabel} DE CAIXA</n></ce>`,
    sepDash(),
    `Caixa   : ${payload.numeroCaixa || "Principal"}`,
    `Operador: ${tx(payload.operador || "-")}`,
    `Data/Hr : ${payload.emitidoEm || new Date().toLocaleString("pt-BR")}`,
    sepDash(),
    `<n>Valor   : ${fmtR$(payload.valor)}</n>`,
    `Motivo  : ${tx(payload.motivo || "-")}`,
    `Saldo   : ${fmtR$(payload.saldoAtual)}`,
    sepEq(),
    tagCorte(),
  ];
  return lines.filter(Boolean).join("\n") + "\n";
}

module.exports = {
  renderAberturaTags,
  renderFechamentoTags,
  renderMovimentoCaixaTags,
};
