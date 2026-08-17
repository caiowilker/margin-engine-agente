/**
 * Layouts térmicos de caixa (abertura / fechamento / suprimento / sangria).
 * Fonte única para ACBr tags e ESC/POS — cupom fiscal não passa por aqui.
 *
 * Formato real de comprovante de turno BR:
 * - Título expandido + dados do posto
 * - Valores alinhados (col2) — fácil de conferir no fechamento
 * - Conferência com OK / Sobra / Falta explícitos
 */
const { toThermalText, toThermalDoc } = require("../thermalText");
const { getThermalCols, sepEq, sepDash, col2 } = require("./thermalCols");

function tx(v) {
  return toThermalText(v);
}

function fmtR$(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return (
    "R$ " +
    Number(v).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtR$OrDash(v) {
  const f = fmtR$(v);
  return f == null ? "--" : f;
}

const FORMA_LABELS = Object.freeze({
  dinheiro: "Dinheiro",
  pix: "PIX",
  credito: "Credito",
  debito: "Debito",
  fiado: "Fiado",
  voucher: "Voucher",
  outros: "Outros",
  crediario: "Crediario",
});

function labelForma(forma) {
  const key = String(forma || "").toLowerCase();
  return FORMA_LABELS[key] || tx(forma);
}

function nomeEmpresa(empresa) {
  const e = empresa || {};
  return tx(
    (e.nome || e.nomeFantasia || e.razaoSocial || "PDV").toUpperCase(),
  );
}

function enderecoEmpresa(empresa) {
  const e = empresa || {};
  const log = (e.logradouro || "").trim();
  if (log) {
    return tx([log, e.numero, e.bairro].filter(Boolean).join(", "));
  }
  return e.endereco ? tx(String(e.endereco)) : "";
}

function pushSep(lines, style = "eq") {
  lines.push({ kind: "sep", text: style === "dash" ? sepDash() : sepEq() });
}

function pushHeaderEmpresa(lines, empresa, { withAddress = false } = {}) {
  const nome = nomeEmpresa(empresa);
  if (nome) {
    lines.push({ kind: "text", text: nome, bold: true, center: true, size: "md" });
  }
  if (empresa?.cnpj) {
    lines.push({
      kind: "text",
      text: `CNPJ ${toThermalDoc(empresa.cnpj)}`,
      center: true,
      size: "sm",
    });
  }
  if (withAddress) {
    const end = enderecoEmpresa(empresa);
    if (end) {
      lines.push({
        kind: "text",
        text: end.slice(0, getThermalCols()),
        center: true,
        size: "sm",
      });
    }
  }
}

function fmtTempoAberto(minutos) {
  const m = Number(minutos) || 0;
  if (m <= 0) return null;
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h > 0) return `${h}h ${String(min).padStart(2, "0")}min`;
  return `${min}min`;
}

/**
 * @returns {{ showLogo: boolean, lines: Array<object> }}
 */
function buildAberturaLayout(payload = {}) {
  const cols = getThermalCols();
  const lines = [];

  pushSep(lines);
  lines.push({
    kind: "text",
    text: "ABERTURA DE CAIXA",
    bold: true,
    center: true,
    size: "lg",
  });
  pushSep(lines);
  pushHeaderEmpresa(lines, payload.empresa);
  lines.push({ kind: "blank" });

  lines.push({
    kind: "text",
    text: col2("Caixa", String(payload.numeroCaixa || "Principal"), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Operador", tx(payload.operador || "-"), cols),
  });
  lines.push({
    kind: "text",
    text: col2(
      "Data/Hr",
      tx(payload.aberturaEm || new Date().toLocaleString("pt-BR")),
      cols,
    ),
  });

  pushSep(lines, "dash");
  lines.push({ kind: "text", text: "FUNDO DE CAIXA", bold: true, center: true });
  lines.push({
    kind: "text",
    text: fmtR$OrDash(payload.valorAbertura),
    bold: true,
    center: true,
    size: "lg",
  });
  pushSep(lines);

  return { showLogo: payload.exibirLogo !== false, lines };
}

/**
 * @returns {{ showLogo: boolean, lines: Array<object> }}
 */
function buildMovimentoLayout(payload = {}) {
  const cols = getThermalCols();
  const isSuprimento = String(payload.tipo || "").toLowerCase() === "suprimento";
  const titulo = isSuprimento ? "SUPRIMENTO" : "SANGRIA";
  const lines = [];

  pushSep(lines);
  lines.push({
    kind: "text",
    text: `${titulo} DE CAIXA`,
    bold: true,
    center: true,
    size: "lg",
  });
  lines.push({
    kind: "text",
    text: isSuprimento ? "Entrada de numerario" : "Retirada de numerario",
    center: true,
    size: "sm",
  });
  pushSep(lines);

  if (payload.empresa?.nome || payload.empresa?.nomeFantasia) {
    pushHeaderEmpresa(lines, payload.empresa);
    lines.push({ kind: "blank" });
  }

  lines.push({
    kind: "text",
    text: col2("Caixa", String(payload.numeroCaixa || "Principal"), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Operador", tx(payload.operador || "-"), cols),
  });
  lines.push({
    kind: "text",
    text: col2(
      "Data/Hr",
      tx(payload.emitidoEm || new Date().toLocaleString("pt-BR")),
      cols,
    ),
  });

  pushSep(lines, "dash");
  lines.push({ kind: "text", text: "VALOR", bold: true, center: true });
  lines.push({
    kind: "text",
    text: fmtR$OrDash(payload.valor),
    bold: true,
    center: true,
    size: "lg",
  });

  if (payload.motivo) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: "Motivo", bold: true });
    lines.push({ kind: "text", text: tx(payload.motivo) });
  }

  pushSep(lines, "dash");
  lines.push({
    kind: "text",
    text: col2("Saldo apos", fmtR$OrDash(payload.saldoAtual), cols),
    bold: true,
  });
  pushSep(lines);

  return { showLogo: payload.exibirLogo !== false, lines };
}

/**
 * @returns {{ showLogo: boolean, lines: Array<object> }}
 */
function buildFechamentoLayout(payload = {}) {
  const cols = getThermalCols();
  const lines = [];

  pushSep(lines);
  lines.push({
    kind: "text",
    text: "FECHAMENTO DE CAIXA",
    bold: true,
    center: true,
    size: "lg",
  });
  pushSep(lines);
  pushHeaderEmpresa(lines, payload.empresa, { withAddress: true });
  lines.push({ kind: "blank" });

  lines.push({
    kind: "text",
    text: col2("Caixa", String(payload.numeroCaixa || "Principal"), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Operador", tx(payload.operador || "-"), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Abertura", tx(payload.aberturaEm || "-"), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Fechamento", tx(payload.fechamentoEm || "-"), cols),
  });
  const tempo = fmtTempoAberto(payload.minutosAberto);
  if (tempo) {
    lines.push({ kind: "text", text: col2("Tempo", tempo, cols) });
  }

  pushSep(lines, "dash");
  lines.push({ kind: "text", text: "RESUMO DO TURNO", bold: true, center: true });
  pushSep(lines, "dash");
  lines.push({
    kind: "text",
    text: col2("Vendas", String(payload.quantidadeVendas ?? 0), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Faturamento", fmtR$OrDash(payload.totalVendas), cols),
    bold: true,
  });
  if (payload.totalLucro != null && Number(payload.totalLucro) !== 0) {
    lines.push({
      kind: "text",
      text: col2("Lucro", fmtR$OrDash(payload.totalLucro), cols),
    });
  }
  if (payload.margemMedia != null && Number(payload.margemMedia) !== 0) {
    lines.push({
      kind: "text",
      text: col2("Margem", `${Number(payload.margemMedia).toFixed(1)}%`, cols),
    });
  }

  const formas = payload.resumoPorForma || {};
  const formasOrdenadas = Object.entries(formas).sort(
    ([, a], [, b]) => Number(b?.total || 0) - Number(a?.total || 0),
  );
  if (formasOrdenadas.length) {
    pushSep(lines, "dash");
    lines.push({
      kind: "text",
      text: "FORMAS DE PAGAMENTO",
      bold: true,
      center: true,
    });
    pushSep(lines, "dash");
    for (const [forma, d] of formasOrdenadas) {
      const label = labelForma(forma);
      const total = fmtR$OrDash(d?.total);
      const qtd = Number(d?.quantidade || 0);
      const left = qtd > 0 ? `${label} (${qtd})` : label;
      lines.push({ kind: "text", text: col2(left, total, cols) });
    }
  }

  if (payload.totais && typeof payload.totais === "object") {
    const entries = Object.entries(payload.totais);
    if (entries.length) {
      pushSep(lines, "dash");
      lines.push({ kind: "text", text: "OUTROS TOTAIS", bold: true, center: true });
      for (const [k, v] of entries) {
        lines.push({ kind: "text", text: col2(tx(k), fmtR$OrDash(v), cols) });
      }
    }
  }

  const hasConf =
    payload.valorAbertura != null ||
    payload.valorContado != null ||
    payload.totalSangrias != null ||
    payload.totalSuprimentos != null ||
    payload.dinheiroEmCaixa != null;

  if (hasConf) {
    pushSep(lines, "dash");
    lines.push({
      kind: "text",
      text: "CONFERENCIA",
      bold: true,
      center: true,
    });
    pushSep(lines, "dash");

    if (payload.valorAbertura != null || payload.valorContado != null) {
      lines.push({
        kind: "text",
        text: col2("Fundo abertura", fmtR$OrDash(payload.valorAbertura), cols),
      });
    }
    if (payload.totalSuprimentos != null && Number(payload.totalSuprimentos) !== 0) {
      lines.push({
        kind: "text",
        text: col2("Suprimentos (+)", fmtR$OrDash(payload.totalSuprimentos), cols),
      });
    }
    if (payload.totalSangrias != null && Number(payload.totalSangrias) !== 0) {
      lines.push({
        kind: "text",
        text: col2("Sangrias (-)", fmtR$OrDash(payload.totalSangrias), cols),
      });
    }
    if (payload.dinheiroEmCaixa != null) {
      lines.push({
        kind: "text",
        text: col2("Dinheiro em caixa", fmtR$OrDash(payload.dinheiroEmCaixa), cols),
      });
    }
    if (payload.caucaoRetida != null && Number(payload.caucaoRetida) > 0.009) {
      lines.push({
        kind: "text",
        text: col2("Caucao retida", fmtR$OrDash(payload.caucaoRetida), cols),
        bold: true,
      });
      lines.push({
        kind: "text",
        text: "(separar — nao e venda)",
        center: true,
      });
    }
    if (payload.valorContado != null) {
      lines.push({
        kind: "text",
        text: col2("Valor contado", fmtR$OrDash(payload.valorContado), cols),
        bold: true,
      });
    }

    if (payload.diferenca != null || payload.valorContado != null) {
      const diff = Number(payload.diferenca ?? 0);
      let diffLabel;
      let diffVal;
      if (Math.abs(diff) < 0.02) {
        diffLabel = "Diferenca";
        diffVal = "OK - confere";
      } else if (diff > 0) {
        diffLabel = "Sobra";
        diffVal = fmtR$OrDash(diff);
      } else {
        diffLabel = "Falta";
        diffVal = fmtR$OrDash(Math.abs(diff));
      }
      lines.push({
        kind: "text",
        text: col2(diffLabel, diffVal, cols),
        bold: true,
      });
    }
  }

  if (payload.valorFechamento != null) {
    pushSep(lines, "dash");
    lines.push({
      kind: "text",
      text: col2("TOTAL", fmtR$OrDash(payload.valorFechamento), cols),
      bold: true,
      size: "md",
    });
  }

  if (payload.observacao) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: `Obs: ${tx(payload.observacao)}` });
  }

  pushSep(lines);
  lines.push({
    kind: "text",
    text: `Encerrado em ${tx(payload.fechamentoEm || "-")}`,
    center: true,
    size: "sm",
  });
  pushSep(lines);

  return { showLogo: payload.exibirLogo !== false, lines };
}

module.exports = {
  buildAberturaLayout,
  buildFechamentoLayout,
  buildMovimentoLayout,
  pushHeaderEmpresa,
  pushSep,
  fmtR$,
  fmtR$OrDash,
  labelForma,
  FORMA_LABELS,
};
