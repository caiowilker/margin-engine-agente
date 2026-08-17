/**
 * Relatório térmico das vendas selecionadas — cada venda com todos os produtos
 * e um consolidado no final. Não é cupom fiscal; não abre gaveta.
 */
const { toThermalText } = require("../thermalText");
const {
  getThermalCols,
  col2,
  padR,
  padL,
  isNarrowThermal,
} = require("./thermalCols");
const {
  pushHeaderEmpresa,
  pushSep,
  fmtR$,
  fmtR$OrDash,
  labelForma,
} = require("./caixaLayout");

const MAX_VENDAS_LAYOUT = 80;

function tx(v) {
  return toThermalText(v);
}

function fmtQtd(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return n.toLocaleString("pt-BR", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function asNumero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Valor curto na coluna (sem "R$") para caber QTD + NOME + UNIT + TOTAL. */
function fmtMoney(v) {
  if (v == null || Number.isNaN(Number(v))) return "--";
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function itensDaVenda(v) {
  return Array.isArray(v?.itens) ? v.itens : [];
}

function flattenItens(vendas) {
  const out = [];
  for (const v of vendas) out.push(...itensDaVenda(v));
  return out;
}

/**
 * @param {object} payload
 * @returns {object}
 */
function normalizarRelatorioVendasPayload(payload = {}) {
  const operador = String(payload.operador || "").trim();
  if (!operador) {
    throw new Error("Operador obrigatório para relatório de vendas.");
  }
  const vendas = Array.isArray(payload.vendas) ? payload.vendas : [];
  let itens = Array.isArray(payload.itens) ? payload.itens : [];
  if (!itens.length) itens = flattenItens(vendas);
  if (!vendas.length) {
    throw new Error("Selecione ao menos uma venda.");
  }
  if (vendas.length > MAX_VENDAS_LAYOUT) {
    throw new Error(
      `Muitas vendas para um cupom térmico (máximo ${MAX_VENDAS_LAYOUT}).`,
    );
  }
  if (!itens.length) {
    throw new Error("Nenhum produto nas vendas selecionadas.");
  }
  return { ...payload, operador, vendas, itens };
}

function nomeItem(item) {
  const nome = tx(item.nome || "ITEM");
  const cod = String(item.codigo || "").trim();
  if (!cod) return nome;
  return `${cod} ${nome}`.trim();
}

function linhaItemDetalhe(item, cols) {
  const qtd = fmtQtd(item.quantidade);
  const un = String(item.unidade || "").trim();
  const qtdUn = un ? `${qtd} ${un}` : qtd;
  const nome = nomeItem(item);
  const unit = fmtMoney(item.precoUnitario);
  const tot = fmtMoney(item.total);
  if (!isNarrowThermal(cols)) {
    const q = padL(qtdUn, 7);
    const u = padL(unit, 9);
    const t = padL(tot, 10);
    const nameLen = Math.max(8, cols - 7 - 1 - 9 - 10);
    return [q + " " + padR(nome, nameLen) + u + t];
  }
  const qtdTxt = un ? `${qtd} ${un} x ${unit}` : `${qtd} x ${unit}`;
  return [nome.slice(0, cols), col2(`  ${qtdTxt}`, tot, cols)];
}

function linhaItemConsolidado(item, cols) {
  const qtd = fmtQtd(item.quantidade);
  const nome = nomeItem(item);
  const tot = fmtMoney(item.total);
  if (!isNarrowThermal(cols)) {
    const q = padL(qtd, 6);
    const t = padL(tot, 12);
    const nameLen = Math.max(8, cols - 6 - 1 - 12);
    return [q + " " + padR(nome, nameLen) + t];
  }
  return [`${qtd}x ${nome}`.slice(0, cols), col2("", tot, cols)];
}

function textoFormas(formas) {
  if (!Array.isArray(formas) || !formas.length) return "";
  return formas
    .map((f) => `${labelForma(f.forma)} ${fmtMoney(f.valor)}`)
    .join(" + ");
}

function pushBlocoVenda(lines, venda, cols) {
  const num = tx(venda.numero || venda.numeroVenda || "-");
  const quando = venda.emitidoEm ? tx(String(venda.emitidoEm)) : "";
  pushSep(lines, "dash");
  lines.push({
    kind: "text",
    text: col2(`VENDA ${num}`, fmtR$OrDash(venda.total), cols),
    bold: true,
  });
  if (quando) {
    lines.push({ kind: "text", text: col2("Data", quando, cols) });
  }
  if (venda.operador) {
    lines.push({ kind: "text", text: col2("Operador", tx(venda.operador), cols) });
  }
  if (venda.cliente) {
    lines.push({ kind: "text", text: col2("Cliente", tx(venda.cliente), cols) });
  }
  if (venda.documento) {
    lines.push({ kind: "text", text: col2("Doc", tx(venda.documento), cols) });
  }
  const pag = textoFormas(venda.formas);
  if (pag) {
    lines.push({ kind: "text", text: col2("Pagamento", pag.slice(0, Math.max(10, cols - 11)), cols) });
    if (pag.length > Math.max(10, cols - 11)) {
      lines.push({ kind: "text", text: pag.slice(Math.max(10, cols - 11)), size: "sm" });
    }
  }

  const itens = itensDaVenda(venda);
  if (!isNarrowThermal(cols) && itens.length) {
    const nameLen = Math.max(8, cols - 7 - 1 - 9 - 10);
    lines.push({
      kind: "text",
      text: padL("QTD", 7) + " " + padR("PRODUTO", nameLen) + padL("UNIT", 9) + padL("TOTAL", 10),
      size: "sm",
    });
  }
  for (const it of itens) {
    for (const text of linhaItemDetalhe(it, cols)) {
      lines.push({ kind: "text", text });
    }
  }
  if (!itens.length) {
    lines.push({ kind: "text", text: "(sem itens)", size: "sm" });
  }

  const sub = asNumero(venda.subtotal);
  const desc = asNumero(venda.desconto);
  const acr = asNumero(venda.acrescimo);
  if (sub > 0 && Math.abs(sub - asNumero(venda.total)) > 0.009) {
    lines.push({ kind: "text", text: col2("Subtotal", fmtR$OrDash(sub), cols) });
  }
  if (desc > 0.009) {
    lines.push({ kind: "text", text: col2("Desconto", fmtR$OrDash(desc), cols) });
  }
  if (acr > 0.009) {
    lines.push({ kind: "text", text: col2("Acrescimo", fmtR$OrDash(acr), cols) });
  }
  lines.push({
    kind: "text",
    text: col2("Total venda", fmtR$OrDash(venda.total), cols),
    bold: true,
  });
}

/**
 * @returns {{ showLogo: boolean, lines: Array<object> }}
 */
function buildRelatorioVendasLayout(raw = {}) {
  const payload = normalizarRelatorioVendasPayload(raw);
  const cols = getThermalCols();
  const lines = [];
  const vendas = payload.vendas.slice();

  pushSep(lines);
  lines.push({
    kind: "text",
    text: "RELATORIO DE VENDAS",
    bold: true,
    center: true,
    size: "lg",
  });
  lines.push({
    kind: "text",
    text: "Comprovante nao fiscal",
    center: true,
    size: "sm",
  });
  pushSep(lines);
  pushHeaderEmpresa(lines, payload.empresa, { withAddress: true });
  lines.push({ kind: "blank" });

  lines.push({
    kind: "text",
    text: col2("Emitido por", tx(payload.operador), cols),
  });
  if (payload.impressoEm) {
    lines.push({
      kind: "text",
      text: col2("Impresso", tx(payload.impressoEm), cols),
    });
  }
  if (payload.periodoDe || payload.periodoAte) {
    const de = tx(payload.periodoDe || "-");
    const ate = tx(payload.periodoAte || "-");
    lines.push({
      kind: "text",
      text: `Periodo ${de} a ${ate}`.slice(0, cols),
    });
  }

  const qtdVendas = payload.quantidadeVendas ?? vendas.length;
  const faturamento =
    payload.faturamento != null
      ? asNumero(payload.faturamento)
      : vendas.reduce((s, v) => s + asNumero(v.total), 0);
  const qtdItens =
    payload.quantidadeItens != null
      ? asNumero(payload.quantidadeItens)
      : flattenItens(vendas).reduce((s, it) => s + asNumero(it.quantidade), 0);

  pushSep(lines, "dash");
  lines.push({
    kind: "text",
    text: col2("Vendas", String(qtdVendas), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Itens", fmtQtd(qtdItens), cols),
  });
  lines.push({
    kind: "text",
    text: col2("Faturamento", fmtR$OrDash(faturamento), cols),
    bold: true,
  });

  for (const v of vendas) {
    pushBlocoVenda(lines, v, cols);
  }

  const consolidado = Array.isArray(payload.itens) ? payload.itens.slice() : [];
  consolidado.sort((a, b) => asNumero(b.total) - asNumero(a.total));
  if (consolidado.length) {
    pushSep(lines);
    lines.push({
      kind: "text",
      text: "CONSOLIDADO DE PRODUTOS",
      bold: true,
      center: true,
    });
    lines.push({
      kind: "text",
      text: "Quantidades somadas nas vendas",
      center: true,
      size: "sm",
    });
    pushSep(lines, "dash");
    if (!isNarrowThermal(cols)) {
      const nameLen = Math.max(8, cols - 6 - 1 - 12);
      lines.push({
        kind: "text",
        text: padL("QTD", 6) + " " + padR("PRODUTO", nameLen) + padL("TOTAL", 12),
        size: "sm",
      });
    }
    for (const it of consolidado) {
      for (const text of linhaItemConsolidado(it, cols)) {
        lines.push({ kind: "text", text });
      }
    }
  }

  const formas = payload.resumoPorForma || {};
  const formasOrdenadas = Object.entries(formas).sort(
    ([, a], [, b]) => asNumero(b?.total) - asNumero(a?.total),
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
      const qtd = Number(d?.quantidade || 0);
      const label = qtd > 0 ? `${labelForma(forma)} (${qtd})` : labelForma(forma);
      lines.push({
        kind: "text",
        text: col2(label, fmtR$OrDash(d?.total), cols),
      });
    }
  }

  const descTotal = asNumero(payload.descontoTotal);
  const acrTotal = asNumero(payload.acrescimoTotal);
  pushSep(lines);
  if (descTotal > 0.009) {
    lines.push({
      kind: "text",
      text: col2("Descontos", fmtR$OrDash(descTotal), cols),
    });
  }
  if (acrTotal > 0.009) {
    lines.push({
      kind: "text",
      text: col2("Acrescimos", fmtR$OrDash(acrTotal), cols),
    });
  }
  lines.push({
    kind: "text",
    text: col2("TOTAL", fmtR$(faturamento) || "R$ 0,00", cols),
    bold: true,
  });
  pushSep(lines);
  lines.push({
    kind: "text",
    text: "Nao substitui o cupom fiscal.",
    center: true,
    size: "sm",
  });
  lines.push({
    kind: "text",
    text: `${qtdVendas} venda(s) · ${fmtQtd(qtdItens)} item(ns)`,
    center: true,
    size: "sm",
  });

  return { showLogo: payload.exibirLogo !== false, lines };
}

module.exports = {
  buildRelatorioVendasLayout,
  normalizarRelatorioVendasPayload,
  MAX_VENDAS_LAYOUT,
  fmtQtd,
};
