/**
 * Normalização e rótulos — comanda Order Engine (paridade front ↔ backend).
 */
const { toThermalText } = require("../thermalText");

const PRINT_TYPE_LABELS = Object.freeze({
  cozinha: "COZINHA",
  bar: "BAR",
  producao: "PRODUCAO",
  cliente: "CLIENTE",
  entrega: "ENTREGA",
});

/** Rótulos ASCII — térmicas ESC/POS sem code page UTF-8 imprimem "?" em acentos/travessão. */
const EVENT_TYPE_LABELS = Object.freeze({
  ORDER_CREATED: "Pedido criado",
  ORDER_UPDATED: "Pedido atualizado",
  ORDER_CANCELLED: "Pedido cancelado",
  ORDER_CONFIRMED: "Pedido confirmado",
  ORDER_PREPARING: "Em preparo",
  ORDER_READY: "Pedido pronto",
  ORDER_DELIVERED: "Em entrega",
  ORDER_FINISHED: "Pedido finalizado",
  PRE_CONTA: "Pre-conta - cobranca",
  BILL_REQUESTED: "Pre-conta - cobranca",
  SEGUNDA_VIA: "2a via - comanda",
  ORDER_REPRINT: "2a via - comanda",
});

function mapItem(raw) {
  const item = raw || {};
  const notesRaw = item.notes ?? item.observacao ?? item.obs ?? null;
  const qty = Number(item.quantity ?? item.quantidade ?? 0);
  const unitPriceRaw = item.unitPrice ?? item.unit_price ?? item.precoUnitario ?? item.preco_unitario;
  const lineTotalRaw = item.lineTotal ?? item.line_total ?? item.total ?? item.valorTotal;
  const unitPrice =
    unitPriceRaw != null && Number.isFinite(Number(unitPriceRaw))
      ? Number(unitPriceRaw)
      : null;
  let lineTotal =
    lineTotalRaw != null && Number.isFinite(Number(lineTotalRaw))
      ? Number(lineTotalRaw)
      : null;
  if (lineTotal == null && unitPrice != null && qty) {
    lineTotal = Math.round(qty * unitPrice * 100) / 100;
  }
  return {
    code: String(item.code ?? item.codigo ?? ""),
    name: String(item.name ?? item.nome ?? ""),
    quantity: qty,
    unit: item.unit != null ? String(item.unit) : item.unidade != null ? String(item.unidade) : null,
    notes: notesRaw != null && String(notesRaw).trim() ? String(notesRaw).trim() : null,
    unitPrice,
    lineTotal,
  };
}

function normalizarPedidoPayload(raw) {
  const o = raw || {};
  const items = Array.isArray(o.items) ? o.items.map(mapItem) : [];
  const phoneRaw = o.customerPhone ?? o.customer_phone ?? null;
  const addressRaw = o.deliveryAddress ?? o.delivery_address ?? null;
  return {
    jobId: String(o.jobId ?? o.job_id ?? ""),
    printType: String(o.printType ?? o.print_type ?? "cozinha").toLowerCase(),
    eventType: String(o.eventType ?? o.event_type ?? "ORDER_CREATED").toUpperCase(),
    orderNumber: String(o.orderNumber ?? o.order_number ?? ""),
    orderId: String(o.orderId ?? o.order_id ?? ""),
    tableCode: o.tableCode ?? o.table_code ?? null,
    customerName: o.customerName ?? o.customer_name ?? null,
    customerPhone: (() => {
      const raw = phoneRaw != null && String(phoneRaw).trim() ? String(phoneRaw).trim() : null;
      return formatPhoneForPrint(raw);
    })(),
    deliveryAddress:
      addressRaw != null && String(addressRaw).trim() ? String(addressRaw).trim() : null,
    total: o.total != null ? Number(o.total) : null,
    notes: o.notes ?? null,
    priority: String(o.priority ?? "normal"),
    elapsedSeconds: Number(o.elapsedSeconds ?? o.elapsed_seconds ?? 0),
    createdAt: o.createdAt ?? o.created_at ?? null,
    copies: Math.max(1, parseInt(String(o.copies ?? 1), 10) || 1),
    items,
    idempotencyKey:
      o.idempotencyKey != null && String(o.idempotencyKey).trim()
        ? String(o.idempotencyKey).trim()
        : o.idempotency_key != null && String(o.idempotency_key).trim()
          ? String(o.idempotency_key).trim()
          : null,
    exibirLogo: typeof o.exibirLogo === "boolean" ? o.exibirLogo : undefined,
  };
}

/** Quebra texto longo para impressora térmica (cols da bobina ativa). */
function wrapThermalLines(text, maxCols) {
  const cols = maxCols ?? require("./thermalCols").getThermalCols();
  const raw = String(text || "").trim();
  if (!raw) return [];
  const words = raw.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= cols) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= cols) {
      current = word;
    } else {
      for (let i = 0; i < word.length; i += cols) {
        lines.push(word.slice(i, i + cols));
      }
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Telefone legível na comanda: (11) 98888-7777 */
function formatPhoneForPrint(phone) {
  if (phone == null) return null;
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  const raw = String(phone).trim();
  return raw || null;
}

function labelPrintType(printType) {
  return PRINT_TYPE_LABELS[String(printType || "").toLowerCase()] || String(printType || "PEDIDO").toUpperCase();
}

function labelEventType(eventType) {
  const raw =
    EVENT_TYPE_LABELS[String(eventType || "").toUpperCase()] || String(eventType || "Pedido");
  return toThermalText(raw);
}

function fmtQty(qty, unit) {
  const q = Number(qty || 0);
  const n = Number.isInteger(q) ? String(q) : q.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  const u = unit ? ` ${toThermalText(unit)}` : "";
  return `${n}${u}`;
}

function fmtTotal(total) {
  if (total == null || Number.isNaN(total)) return null;
  return toThermalText(
    "R$ " +
      Number(total).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
  );
}

/** Pré-conta / cliente / entrega exibem total (e preços de linha quando houver). */
function deveExibirTotalPedido(printType, eventType) {
  const type = String(printType || "").toLowerCase();
  const ev = String(eventType || "").toUpperCase();
  if (ev === "PRE_CONTA" || ev === "BILL_REQUESTED") return true;
  return type === "cliente" || type === "entrega";
}

function tituloPedidoTermico(printType, eventType) {
  const ev = String(eventType || "").toUpperCase();
  if (ev === "PRE_CONTA" || ev === "BILL_REQUESTED") return "PRE-CONTA";
  return labelPrintType(printType);
}

module.exports = {
  PRINT_TYPE_LABELS,
  EVENT_TYPE_LABELS,
  normalizarPedidoPayload,
  labelPrintType,
  labelEventType,
  tituloPedidoTermico,
  deveExibirTotalPedido,
  fmtQty,
  fmtTotal,
  wrapThermalLines,
  formatPhoneForPrint,
};
