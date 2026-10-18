/**
 * Comprovante não fiscal de recebimento de crediário — tags ACBr.
 * Isolado de cupom fiscal / pedido / caixa / vasilhame (mesmo padrão).
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const { tagLogoHeader, tagCorte, tagSegundaViaBanner } = require("./acbrTags");
const { sepEq, sepDash, getThermalCols } = require("./thermalCols");
const { deveExibirBannerSegundaVia } = require("./segundaVia");
const { linhasCabecalhoEmpresaTags } = require("./empresaCabecalhoTermico");

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

/** Linha label + valor alinhada à direita (padrão cupom). */
function linhaKV(label, value, cols) {
  const left = String(label || "");
  const right = tx(String(value ?? ""));
  const gap = cols - left.length - right.length;
  if (gap >= 1) return left + " ".repeat(gap) + right;
  if (right.length >= cols) return right.slice(0, cols);
  return (left + " " + right).slice(0, cols);
}

function quebrarObs(texto, cols) {
  const raw = tx(String(texto || "")).trim();
  if (!raw) return [];
  const out = [];
  let rest = raw;
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(" ", cols);
    if (cut < Math.floor(cols * 0.4)) cut = cols;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function labelForma(forma) {
  const f = String(forma || "").trim().toUpperCase();
  if (!f) return "";
  if (f === "DINHEIRO") return "Dinheiro";
  if (f === "PIX") return "PIX";
  if (f === "DEBITO" || f === "CARTAO_DEBITO") return "Cartao debito";
  if (f === "CREDITO" || f === "CARTAO_CREDITO") return "Cartao credito";
  return tx(forma);
}

function normalizarCrediarioPayload(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const clickId = String(p.clickId || p.click_id || "").trim();
  const motivo = String(p.motivo || "").trim();
  // clickId sozinho NÃO marca 2ª via (pode existir em 1ª via com dedupe).
  const reimpressao =
    p.reimpressao === true ||
    /reimpress|segunda/.test(motivo.toLowerCase());
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
    reimpressao,
    clickId: clickId || undefined,
    motivo: reimpressao ? motivo || "reimpressao_crediario" : motivo || undefined,
  };
}

function renderCrediarioTags(rawPayload = {}) {
  const payload = normalizarCrediarioPayload(rawPayload);
  const COLS = getThermalCols();
  const lines = ["</zera>", tagLogoHeader(payload)];

  if (deveExibirBannerSegundaVia(payload)) {
    lines.push(tagSegundaViaBanner());
  }

  lines.push(...linhasCabecalhoEmpresaTags(payload.empresa, COLS));

  lines.push(
    sepEq(),
    `<ce><n>${tx(payload.titulo)}</n></ce>`,
    "<ce>Comprovante nao fiscal</ce>",
    sepEq(),
  );

  if (/parcial/i.test(String(payload.titulo || ""))) {
    lines.push("<ce><n>*** PAGAMENTO PARCIAL ***</n></ce>");
  }

  if (payload.clienteNome) {
    lines.push(linhaKV("Cliente", payload.clienteNome, COLS));
  }
  if (payload.clienteDocumento) {
    lines.push(linhaKV("Documento", toThermalDoc(payload.clienteDocumento), COLS));
  }
  if (payload.numeroParcela != null && payload.totalParcelas != null) {
    lines.push(linhaKV("Parcela", `${payload.numeroParcela}/${payload.totalParcelas}`, COLS));
  } else if (payload.parcelasQuitadas != null || payload.parcelasParciais != null) {
    const q = payload.parcelasQuitadas || 0;
    const partial = payload.parcelasParciais || 0;
    lines.push(
      linhaKV(
        "Parcelas",
        `${q} quitada(s)${partial > 0 ? `, ${partial} parcial(is)` : ""}`,
        COLS,
      ),
    );
  }
  if (payload.vencimento) {
    lines.push(linhaKV("Vencimento", payload.vencimento, COLS));
  }
  if (payload.dataRecebimento) {
    lines.push(linhaKV("Data/hora", payload.dataRecebimento, COLS));
  }
  if (payload.operador) {
    lines.push(linhaKV("Operador", payload.operador, COLS));
  }
  if (payload.formaPagamento) {
    lines.push(linhaKV("Forma", labelForma(payload.formaPagamento), COLS));
  }

  lines.push(sepDash());
  lines.push("<ce>VALOR RECEBIDO</ce>");
  lines.push(`<ce><e><n>${fmtR$(payload.valorRecebido)}</n></e></ce>`);

  if (payload.jurosCalculado > 0) {
    lines.push(linhaKV("Juros", fmtR$(payload.jurosCalculado), COLS));
  }
  if (payload.multaCalculada > 0) {
    lines.push(linhaKV("Multa", fmtR$(payload.multaCalculada), COLS));
  }

  lines.push(sepDash());
  lines.push(linhaKV("Saldo anterior", fmtR$(payload.saldoAnterior), COLS));
  lines.push(
    `<n>${linhaKV("Saldo remanescente", fmtR$(payload.saldoRemanescente), COLS)}</n>`,
  );

  if (payload.observacao) {
    lines.push(sepDash(), "<n>Itens / obs.</n>");
    for (const l of quebrarObs(payload.observacao, COLS)) {
      lines.push(l);
    }
  }

  lines.push(
    sepEq(),
    "<ce>Documento nao fiscal</ce>",
    "<ce>Nao substitui NFC-e / cupom fiscal</ce>",
    "<ce>Guarde este comprovante</ce>",
    tagCorte(),
  );
  return lines.filter(Boolean).join("\n") + "\n";
}

module.exports = {
  normalizarCrediarioPayload,
  renderCrediarioTags,
  labelForma,
  quebrarObs,
};
