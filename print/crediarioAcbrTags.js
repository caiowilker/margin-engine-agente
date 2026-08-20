/**
 * Comprovante não fiscal de recebimento de crediário — tags ACBr.
 * Isolado de cupom fiscal / pedido / caixa / vasilhame (mesmo padrão).
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const { tagLogoHeader, tagCorte } = require("./acbrTags");
const { sepEq, sepDash, getThermalCols } = require("./thermalCols");

function tx(v) {
  return toThermalText(v);
}

function fmtR$(reais) {
  const n = Number(reais || 0);
  return (
    "R$ " +
    n.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function normalizarCrediarioPayload(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    ...p,
    naoFiscal: true,
    cupomSemFiscal: true,
    titulo: p.titulo || "RECEBIMENTO CREDIARIO",
    clienteNome: p.clienteNome || p.cliente || "",
    clienteDocumento: p.clienteDocumento || p.documento || "",
    numeroParcela: p.numeroParcela != null ? Number(p.numeroParcela) : null,
    totalParcelas: p.totalParcelas != null ? Number(p.totalParcelas) : null,
    vencimento: p.vencimento || "",
    valorRecebido: Number(p.valorRecebido ?? p.totalRecebido ?? 0),
    jurosCalculado: Number(p.jurosCalculado || 0),
    multaCalculada: Number(p.multaCalculada || 0),
    formaPagamento: p.formaPagamento || p.forma || "",
    operador: p.operador || "",
    saldoAnterior: Number(p.saldoAnterior ?? 0),
    saldoRemanescente: Number(
      p.saldoRemanescente ?? p.totalRestante ?? p.saldoAtual ?? 0,
    ),
    dataRecebimento: p.dataRecebimento || p.emitidoEm || "",
    observacao: p.observacao || p.observacoes || "",
    parcelasQuitadas: p.parcelasQuitadas != null ? Number(p.parcelasQuitadas) : null,
    parcelasParciais: p.parcelasParciais != null ? Number(p.parcelasParciais) : null,
    empresa: p.empresa || null,
    reimpressao: !!p.reimpressao,
    clickId: p.clickId || undefined,
  };
}

function renderCrediarioTags(rawPayload = {}) {
  const payload = normalizarCrediarioPayload(rawPayload);
  const COLS = getThermalCols();
  const lines = ["</zera>", tagLogoHeader(payload)];

  if (payload.empresa?.nome) {
    lines.push(`<ce><n>${tx(payload.empresa.nome)}</n></ce>`);
  }
  if (payload.empresa?.cnpj) {
    lines.push(`CNPJ: ${toThermalDoc(payload.empresa.cnpj)}`);
  }

  lines.push(
    sepEq(),
    `<ce><n>${tx(payload.titulo)}</n></ce>`,
    "<ce>Comprovante nao fiscal</ce>",
    sepEq(),
  );

  if (/parcial/i.test(String(payload.titulo || ""))) {
    lines.push("<ce><n>*** PAGAMENTO PARCIAL ***</n></ce>");
  }
  if (payload.reimpressao) {
    lines.push("<ce><n>*** SEGUNDA VIA ***</n></ce>");
  }

  if (payload.clienteNome) {
    lines.push(`Cliente : ${tx(payload.clienteNome)}`);
  }
  if (payload.clienteDocumento) {
    lines.push(`Doc     : ${toThermalDoc(payload.clienteDocumento)}`);
  }
  if (payload.numeroParcela != null && payload.totalParcelas != null) {
    lines.push(`Parcela : ${payload.numeroParcela}/${payload.totalParcelas}`);
  } else if (payload.parcelasQuitadas != null || payload.parcelasParciais != null) {
    const q = payload.parcelasQuitadas || 0;
    const partial = payload.parcelasParciais || 0;
    lines.push(`Parcelas: ${q} quitada(s)${partial > 0 ? `, ${partial} parcial(is)` : ""}`);
  }
  if (payload.vencimento) {
    lines.push(`Venc.   : ${tx(payload.vencimento)}`);
  }
  if (payload.dataRecebimento) {
    lines.push(`Data/Hr : ${tx(payload.dataRecebimento)}`);
  }
  if (payload.operador) {
    lines.push(`Operador: ${tx(payload.operador)}`);
  }
  if (payload.formaPagamento) {
    lines.push(`Forma   : ${tx(payload.formaPagamento)}`);
  }

  lines.push(sepDash());
  lines.push(`<n>Recebido: ${fmtR$(payload.valorRecebido)}</n>`);
  if (payload.jurosCalculado > 0) {
    lines.push(`Juros   : ${fmtR$(payload.jurosCalculado)}`);
  }
  if (payload.multaCalculada > 0) {
    lines.push(`Multa   : ${fmtR$(payload.multaCalculada)}`);
  }
  lines.push(`Saldo ant.: ${fmtR$(payload.saldoAnterior)}`);
  lines.push(`<n>Saldo rem.: ${fmtR$(payload.saldoRemanescente)}</n>`);

  if (payload.observacao) {
    lines.push(sepDash(), `Obs: ${tx(payload.observacao).slice(0, COLS)}`);
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
  normalizarCrediarioPayload,
  renderCrediarioTags,
};
