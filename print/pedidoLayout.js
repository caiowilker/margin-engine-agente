/**
 * Layouts térmicos de pedido (cozinha / bar / produção / entrega / cliente).
 * Fonte única para ACBr tags e ESC/POS — cupom fiscal não passa por aqui.
 *
 * Convenções reais de salão BR:
 * - Cozinha/Bar: qty grande + nome, obs indentada, SEM preço, SEM SKU, SEM logo.
 * - Entrega: cliente/tel/endereço/pagto/troco em destaque + total.
 * - Pré-conta/cliente: itens com preço + total + aviso não-fiscal.
 */
const { toThermalText } = require("../thermalText");
const {
  normalizarPedidoPayload,
  labelPrintType,
  tituloPedidoTermico,
  deveExibirTotalPedido,
  fmtQty,
  fmtTotal,
  wrapThermalLines,
  labelPaymentForm,
  shortEventBadge,
  isStationTicket,
  formatCreatedAtForPrint,
} = require("./pedidoPrint");
const { getThermalCols, sepEq, sepDash, col2 } = require("./thermalCols");

function tx(v) {
  return toThermalText(v);
}

/** Logo: só cliente/entrega (marca); estações de produção priorizam velocidade. */
function deveExibirLogoPedido(payload) {
  if (typeof payload.exibirLogo === "boolean") return payload.exibirLogo;
  return !isStationTicket(payload.printType);
}

/**
 * @typedef {{ kind: 'text'|'sep'|'blank', text?: string, bold?: boolean, center?: boolean, size?: 'sm'|'md'|'lg' }} LayoutLine
 */

/**
 * @param {ReturnType<typeof normalizarPedidoPayload>} p
 * @returns {{ showLogo: boolean, lines: LayoutLine[] }}
 */
function buildPedidoLayout(rawPayload = {}) {
  const p = normalizarPedidoPayload(rawPayload);
  const type = String(p.printType || "cozinha").toLowerCase();
  const showTotal = deveExibirTotalPedido(p.printType, p.eventType);
  const cancelado = p.eventType === "ORDER_CANCELLED";
  const preConta =
    String(p.eventType || "").toUpperCase() === "PRE_CONTA" ||
    String(p.eventType || "").toUpperCase() === "BILL_REQUESTED";

  if (isStationTicket(type)) {
    return { showLogo: deveExibirLogoPedido(p), lines: layoutEstacao(p, cancelado) };
  }
  if (type === "entrega") {
    return { showLogo: deveExibirLogoPedido(p), lines: layoutEntrega(p, cancelado, showTotal) };
  }
  return {
    showLogo: deveExibirLogoPedido(p),
    lines: layoutCliente(p, cancelado, showTotal, preConta),
  };
}

function pushSep(lines, style = "eq") {
  lines.push({ kind: "sep", text: style === "dash" ? sepDash() : sepEq() });
}

function layoutEstacao(p, cancelado) {
  const lines = [];
  const titulo = labelPrintType(p.printType);
  const badge = shortEventBadge(p.eventType);

  pushSep(lines);
  lines.push({ kind: "text", text: titulo, bold: true, center: true, size: "lg" });
  if (badge) {
    lines.push({ kind: "text", text: badge, bold: true, center: true, size: "md" });
  }
  if (cancelado) {
    lines.push({ kind: "text", text: "*** CANCELADO ***", bold: true, center: true, size: "md" });
  }
  pushSep(lines);

  // Identidade do pedido — mesa tem prioridade visual sobre número
  if (p.tableCode) {
    lines.push({
      kind: "text",
      text: `MESA ${tx(p.tableCode)}`,
      bold: true,
      center: true,
      size: "lg",
    });
  }
  if (p.orderNumber) {
    lines.push({
      kind: "text",
      text: p.tableCode ? `#${tx(p.orderNumber)}` : `PEDIDO ${tx(p.orderNumber)}`,
      bold: !p.tableCode,
      center: true,
      size: p.tableCode ? "md" : "lg",
    });
  }
  if (p.customerName && !p.tableCode) {
    lines.push({ kind: "text", text: tx(p.customerName), center: true, size: "md" });
  }
  if (p.priority && p.priority !== "normal") {
    lines.push({
      kind: "text",
      text: `PRIORIDADE: ${tx(p.priority).toUpperCase()}`,
      bold: true,
      center: true,
    });
  }

  pushSep(lines, "dash");
  appendItensEstacao(lines, p.items);
  pushSep(lines, "dash");

  if (p.notes) {
    for (const noteLine of wrapThermalLines(`Obs: ${tx(p.notes)}`, getThermalCols())) {
      lines.push({ kind: "text", text: noteLine, bold: true });
    }
    pushSep(lines, "dash");
  }

  if (p.createdAt) {
    lines.push({ kind: "text", text: formatCreatedAtForPrint(p.createdAt) || tx(p.createdAt), center: true, size: "sm" });
  }
  pushSep(lines);
  return lines;
}

function appendItensEstacao(lines, items) {
  if (!items.length) {
    lines.push({ kind: "text", text: "(sem itens)", center: true });
    return;
  }
  for (const item of items) {
    const qty = fmtQtyKitchen(item.quantity, item.unit);
    const nome = tx(item.name || item.code || "Item").toUpperCase();
    // "2x  X-BURGER" — qty alinhada à esquerda, nome em destaque
    lines.push({ kind: "text", text: `${qty}  ${nome}`, bold: true, size: "md" });
    if (item.notes) {
      for (const nl of wrapThermalLines(`* ${tx(item.notes)}`, getThermalCols() - 2)) {
        lines.push({ kind: "text", text: `  ${nl}` });
      }
    }
    lines.push({ kind: "blank" });
  }
  // remove trailing blank
  if (lines.length && lines[lines.length - 1].kind === "blank") lines.pop();
}

/** Qty estilo cozinha: "2x" ou "1,5 KG" — sem "UN" ruidoso. */
function fmtQtyKitchen(qty, unit) {
  const q = Number(qty || 0);
  const n = Number.isInteger(q)
    ? String(q)
    : q.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  const u = unit ? String(unit).trim().toUpperCase() : "";
  if (!u || u === "UN" || u === "UND" || u === "UNIDADE") {
    return `${n}x`;
  }
  return `${n} ${toThermalText(u)}`;
}

function layoutEntrega(p, cancelado, showTotal) {
  const lines = [];
  const cols = getThermalCols();

  pushSep(lines);
  lines.push({ kind: "text", text: "ENTREGA", bold: true, center: true, size: "lg" });
  const badge = shortEventBadge(p.eventType);
  if (badge) {
    lines.push({ kind: "text", text: badge, center: true, size: "md" });
  }
  if (cancelado) {
    lines.push({ kind: "text", text: "*** CANCELADO ***", bold: true, center: true });
  }
  pushSep(lines);

  if (p.orderNumber) {
    lines.push({ kind: "text", text: `Pedido ${tx(p.orderNumber)}`, bold: true, size: "md" });
  }
  if (p.customerName) {
    lines.push({ kind: "text", text: tx(p.customerName), bold: true, size: "md" });
  }
  if (p.customerPhone) {
    lines.push({ kind: "text", text: `Tel  ${tx(p.customerPhone)}`, bold: true });
  }
  if (p.courierName) {
    lines.push({ kind: "text", text: `Motoboy  ${tx(p.courierName)}`, bold: true });
  }

  if (p.deliveryAddress) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: "ENDERECO", bold: true });
    for (const al of wrapThermalLines(tx(p.deliveryAddress), cols)) {
      lines.push({ kind: "text", text: al });
    }
  }

  const pagto = labelPaymentForm(p.paymentForm);
  if (pagto || p.cashChangeFor != null || p.changeAmount != null) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: "PAGAMENTO", bold: true });
    if (pagto) {
      lines.push({ kind: "text", text: pagto, bold: true });
    }
    if (p.cashChangeFor != null && Number.isFinite(Number(p.cashChangeFor))) {
      lines.push({
        kind: "text",
        text: col2("Troco para", fmtTotal(p.cashChangeFor) || "", cols),
      });
    }
    if (p.changeAmount != null && Number.isFinite(Number(p.changeAmount))) {
      lines.push({
        kind: "text",
        text: col2("Troco", fmtTotal(p.changeAmount) || "", cols),
        bold: true,
      });
    }
  }

  pushSep(lines, "dash");
  lines.push({ kind: "text", text: "ITENS", bold: true, center: true });
  pushSep(lines, "dash");
  appendItensComPreco(lines, p.items, showTotal, false);
  pushSep(lines, "dash");

  appendCobrancas(lines, p, cols);

  const totalFmt = showTotal ? fmtTotal(p.total) : null;
  if (totalFmt) {
    lines.push({ kind: "text", text: col2("TOTAL", totalFmt, cols), bold: true, size: "md" });
  }

  if (p.notes) {
    lines.push({ kind: "blank" });
    for (const noteLine of wrapThermalLines(`Obs: ${tx(p.notes)}`, cols)) {
      lines.push({ kind: "text", text: noteLine });
    }
  }

  if (p.createdAt) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: formatCreatedAtForPrint(p.createdAt) || tx(p.createdAt), center: true, size: "sm" });
  }
  pushSep(lines);
  return lines;
}

function layoutCliente(p, cancelado, showTotal, preConta) {
  const lines = [];
  const cols = getThermalCols();
  const titulo = tituloPedidoTermico(p.printType, p.eventType);

  pushSep(lines);
  lines.push({ kind: "text", text: titulo, bold: true, center: true, size: "lg" });
  if (preConta) {
    lines.push({
      kind: "text",
      text: "Documento auxiliar - nao e cupom fiscal",
      center: true,
      size: "sm",
    });
  } else {
    const badge = shortEventBadge(p.eventType);
    if (badge) lines.push({ kind: "text", text: badge, center: true, size: "md" });
  }
  if (cancelado) {
    lines.push({ kind: "text", text: "*** CANCELADO ***", bold: true, center: true });
  }
  pushSep(lines);

  if (p.tableCode) {
    lines.push({
      kind: "text",
      text: `MESA ${tx(p.tableCode)}`,
      bold: true,
      center: true,
      size: "lg",
    });
  }
  if (p.orderNumber) {
    lines.push({
      kind: "text",
      text: p.tableCode ? `#${tx(p.orderNumber)}` : `Pedido ${tx(p.orderNumber)}`,
      center: true,
      size: "md",
    });
  }
  if (p.customerName) {
    lines.push({ kind: "text", text: `Cliente: ${tx(p.customerName)}` });
  }

  pushSep(lines, "dash");
  appendItensComPreco(lines, p.items, showTotal, true);
  pushSep(lines, "dash");

  appendCobrancas(lines, p, cols);

  const totalFmt = showTotal ? fmtTotal(p.total) : null;
  if (totalFmt) {
    lines.push({ kind: "text", text: col2("TOTAL", totalFmt, cols), bold: true, size: "md" });
  }

  if (p.notes) {
    lines.push({ kind: "blank" });
    for (const noteLine of wrapThermalLines(`Obs: ${tx(p.notes)}`, cols)) {
      lines.push({ kind: "text", text: noteLine });
    }
  }

  if (p.createdAt) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: formatCreatedAtForPrint(p.createdAt) || tx(p.createdAt), center: true, size: "sm" });
  }
  pushSep(lines);
  return lines;
}

function appendCobrancas(lines, p, cols) {
  if (p.deliveryFee != null) {
    const fmt = fmtTotal(p.deliveryFee);
    if (fmt) {
      lines.push({ kind: "text", text: col2("Taxa de entrega", fmt, cols) });
    }
  }
  if (p.bottleDeposit != null) {
    const fmt = fmtTotal(p.bottleDeposit);
    if (fmt) {
      lines.push({ kind: "text", text: col2("Caucao vasilhame", fmt, cols) });
    }
  }
}

function appendItensComPreco(lines, items, showPrices, showUnitPrice) {
  const cols = getThermalCols();
  if (!items.length) {
    lines.push({ kind: "text", text: "(sem itens)", center: true });
    return;
  }
  for (const item of items) {
    const qty = fmtQtyKitchen(item.quantity, item.unit);
    const nome = tx(item.name || item.code || "Item");
    const head = `${qty}  ${nome}`;
    if (showPrices && item.lineTotal != null) {
      const lineFmt = fmtTotal(item.lineTotal) || "";
      // Uma linha se couber; senão nome + valor abaixo
      if (head.length + 1 + lineFmt.length <= cols) {
        lines.push({ kind: "text", text: col2(head, lineFmt, cols), bold: true });
      } else {
        lines.push({ kind: "text", text: head, bold: true });
        lines.push({ kind: "text", text: col2("", lineFmt, cols) });
      }
      if (showUnitPrice && item.unitPrice != null && item.quantity !== 1) {
        const u = fmtTotal(item.unitPrice);
        if (u) lines.push({ kind: "text", text: `    ${u} un`, size: "sm" });
      }
    } else {
      lines.push({ kind: "text", text: head, bold: true });
    }
    if (item.notes) {
      for (const nl of wrapThermalLines(`* ${tx(item.notes)}`, cols - 2)) {
        lines.push({ kind: "text", text: `  ${nl}` });
      }
    }
  }
}

module.exports = {
  buildPedidoLayout,
  deveExibirLogoPedido,
  fmtQtyKitchen,
};
