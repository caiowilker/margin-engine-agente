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
  const lines = ["</zera>", tagLogoHeader(payload)];
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
    `<n>Fundo   : ${
      payload.valorAbertura == null || Number.isNaN(Number(payload.valorAbertura))
        ? "--"
        : fmtR$(payload.valorAbertura)
    }</n>`,
    sepEq(),
    tagCorte(),
  );
  return lines.filter(Boolean).join("\n") + "\n";
}

function nomeEmpresaCaixa(empresa) {
  const e = empresa || {};
  return tx(
    (e.nome || e.nomeFantasia || e.razaoSocial || "PDV").toUpperCase(),
  );
}

function renderFechamentoTags(payload = {}) {
  const lines = ["</zera>", tagLogoHeader(payload)];
  lines.push(`<ce><n>${nomeEmpresaCaixa(payload.empresa)}</n></ce>`);
  if (payload.empresa?.cnpj) {
    lines.push(`CNPJ: ${toThermalDoc(payload.empresa.cnpj)}`);
  }
  const end = formatarLinhaEndereco(payload.empresa);
  if (end) lines.push(end.slice(0, COLS));
  if (payload.empresa?.endereco && !end) {
    lines.push(tx(String(payload.empresa.endereco)).slice(0, COLS));
  }
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

  lines.push(sepDash(), "<n>RESUMO DO DIA</n>");
  lines.push(`Vendas      : ${payload.quantidadeVendas ?? 0}`);
  lines.push(`Faturamento : ${fmtR$(payload.totalVendas)}`);
  if (payload.totalLucro != null && Number(payload.totalLucro) !== 0) {
    lines.push(`Lucro total : ${fmtR$(payload.totalLucro)}`);
  }
  if (payload.margemMedia != null && Number(payload.margemMedia) !== 0) {
    lines.push(`Margem media: ${Number(payload.margemMedia).toFixed(1)}%`);
  }

  const formas = payload.resumoPorForma || {};
  const formasOrdenadas = Object.entries(formas).sort(
    ([, a], [, b]) => Number(b.total || 0) - Number(a.total || 0),
  );
  if (formasOrdenadas.length) {
    lines.push(sepDash(), "<n>POR FORMA DE PAGAMENTO</n>");
    for (const [forma, d] of formasOrdenadas) {
      const label =
        {
          dinheiro: "Dinheiro",
          pix: "PIX",
          credito: "Credito",
          debito: "Debito",
          fiado: "Fiado",
          voucher: "Voucher",
          outros: "Outros",
          crediario: "Crediario",
        }[forma] || forma;
      const qtd =
        d?.quantidade > 0 ? ` (${d.quantidade} venda(s))` : "";
      lines.push(`${label}: ${fmtR$(d?.total)}${qtd}`);
    }
  }

  if (payload.totais && typeof payload.totais === "object") {
    lines.push(sepDash(), "<n>RESUMO</n>");
    for (const [k, v] of Object.entries(payload.totais)) {
      lines.push(`${tx(k)}: ${fmtR$(v)}`);
    }
  }

  if (payload.valorAbertura != null || payload.valorContado != null) {
    lines.push(sepDash(), "<n>CONFERENCIA DE CAIXA</n>");
    lines.push(
      `Fundo abertura: ${
        payload.valorAbertura == null || Number.isNaN(Number(payload.valorAbertura))
          ? "--"
          : fmtR$(payload.valorAbertura)
      }`,
    );
    lines.push(`Valor contado : ${fmtR$(payload.valorContado)}`);
    const diff = Number(payload.diferenca ?? 0);
    const diffStr =
      Math.abs(diff) < 0.02
        ? "OK - caixa confere"
        : diff > 0
          ? `Sobra: ${fmtR$(diff)}`
          : `Falta: ${fmtR$(Math.abs(diff))}`;
    lines.push(`Diferenca     : ${tx(diffStr)}`);
  }

  if (payload.valorFechamento != null) {
    lines.push(sepDash(), `<n>Total   : ${fmtR$(payload.valorFechamento)}</n>`);
  }

  if (payload.observacao) {
    lines.push(sepDash(), `Obs: ${tx(payload.observacao)}`);
  }

  lines.push(
    sepEq(),
    `<ce>Caixa encerrado em ${payload.fechamentoEm || "-"}</ce>`,
    tagCorte(),
  );
  return lines.filter(Boolean).join("\n") + "\n";
}

function renderMovimentoCaixaTags(payload = {}) {
  const tipoLabel = payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";
  const lines = [
    "</zera>",
    tagLogoHeader(payload),
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
