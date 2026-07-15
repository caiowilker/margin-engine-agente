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
  return {
    code: String(item.code ?? item.codigo ?? ""),
    name: String(item.name ?? item.nome ?? ""),
    quantity: Number(item.quantity ?? item.quantidade ?? 0),
    unit: item.unit != null ? String(item.unit) : item.unidade != null ? String(item.unidade) : null,
  };
}

function normalizarPedidoPayload(raw) {
  const o = raw || {};
  const items = Array.isArray(o.items) ? o.items.map(mapItem) : [];
  return {
    jobId: String(o.jobId ?? o.job_id ?? ""),
    printType: String(o.printType ?? o.print_type ?? "cozinha").toLowerCase(),
    eventType: String(o.eventType ?? o.event_type ?? "ORDER_CREATED").toUpperCase(),
    orderNumber: String(o.orderNumber ?? o.order_number ?? ""),
    orderId: String(o.orderId ?? o.order_id ?? ""),
    tableCode: o.tableCode ?? o.table_code ?? null,
    customerName: o.customerName ?? o.customer_name ?? null,
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
};
