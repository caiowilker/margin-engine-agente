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

const EVENT_TYPE_LABELS = Object.freeze({
  ORDER_CREATED: "Pedido criado",
  ORDER_UPDATED: "Pedido atualizado",
  ORDER_CANCELLED: "Pedido cancelado",
  ORDER_CONFIRMED: "Pedido confirmado",
  ORDER_PREPARING: "Em preparo",
  ORDER_READY: "Pedido pronto",
  ORDER_DELIVERED: "Em entrega",
  ORDER_FINISHED: "Pedido finalizado",
});

function mapItem(raw) {
  const item = raw || {};
  const notesRaw = item.notes ?? item.observacao ?? item.obs ?? null;
  return {
    code: String(item.code ?? item.codigo ?? ""),
    name: String(item.name ?? item.nome ?? ""),
    quantity: Number(item.quantity ?? item.quantidade ?? 0),
    unit: item.unit != null ? String(item.unit) : item.unidade != null ? String(item.unidade) : null,
    notes: notesRaw != null && String(notesRaw).trim() ? String(notesRaw).trim() : null,
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
    exibirLogo: typeof o.exibirLogo === "boolean" ? o.exibirLogo : undefined,
  };
}

/** Quebra texto longo para impressora térmica (cols padrão 48). */
function wrapThermalLines(text, maxCols = 48) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const words = raw.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCols) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= maxCols) {
      current = word;
    } else {
      for (let i = 0; i < word.length; i += maxCols) {
        lines.push(word.slice(i, i + maxCols));
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
  return EVENT_TYPE_LABELS[String(eventType || "").toUpperCase()] || String(eventType || "Pedido");
}

function fmtQty(qty, unit) {
  const q = Number(qty || 0);
  const n = Number.isInteger(q) ? String(q) : q.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  const u = unit ? ` ${toThermalText(unit)}` : "";
  return `${n}${u}`;
}

function fmtTotal(total) {
  if (total == null || Number.isNaN(total)) return null;
  return (
    "R$ " +
    Number(total).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

module.exports = {
  PRINT_TYPE_LABELS,
  EVENT_TYPE_LABELS,
  normalizarPedidoPayload,
  labelPrintType,
  labelEventType,
  fmtQty,
  fmtTotal,
  wrapThermalLines,
  formatPhoneForPrint,
};
