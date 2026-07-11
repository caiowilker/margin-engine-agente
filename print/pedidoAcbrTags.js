/**
 * Comanda Order Engine em tags ACBr — mesma identidade visual do cupom (48 col).
 */
const { toThermalText } = require("../thermalText");
const { tagCorte } = require("./acbrTags");
const {
  labelPrintType,
  labelEventType,
  fmtQty,
  fmtTotal,
  normalizarPedidoPayload,
} = require("./pedidoPrint");

const COLS = 48;

function sepEq() {
  return "=".repeat(COLS);
}
function sepDash() {
  return "-".repeat(COLS);
}
function tx(v) {
  return toThermalText(v);
}

function renderPedidoTags(rawPayload = {}) {
  const payload = normalizarPedidoPayload(rawPayload);
  const lines = ["</zera>"];
  const estacao = labelPrintType(payload.printType);
  const evento = labelEventType(payload.eventType);
  const cancelado = payload.eventType === "ORDER_CANCELLED";

  lines.push(
    sepEq(),
    `<ce><n>${estacao}</n></ce>`,
    `<ce>${tx(evento)}</ce>`,
  );
  if (cancelado) {
    lines.push("<ce><n>*** CANCELADO ***</n></ce>");
  }
  lines.push(sepEq());

  if (payload.orderNumber) {
    lines.push(`Pedido : ${tx(payload.orderNumber)}`);
  }
  if (payload.tableCode) {
    lines.push(`Mesa   : ${tx(payload.tableCode)}`);
  }
  if (payload.customerName) {
    lines.push(`Cliente: ${tx(payload.customerName)}`);
  }
  if (payload.createdAt) {
    lines.push(`Data/Hr: ${tx(payload.createdAt)}`);
  }
  if (payload.elapsedSeconds > 0) {
    lines.push(`Tempo  : ${payload.elapsedSeconds}s`);
  }
  if (payload.priority && payload.priority !== "normal") {
    lines.push(`Prior. : ${tx(payload.priority).toUpperCase()}`);
  }

  lines.push(sepDash(), "<n>ITENS</n>", sepDash());

  if (!payload.items.length) {
    lines.push("(sem itens)");
  } else {
    for (const item of payload.items) {
      const qty = fmtQty(item.quantity, item.unit);
      const nome = tx(item.name || item.code || "Item");
      lines.push(`${qty} x ${nome}`);
      if (item.code && item.name) {
        lines.push(`  Cod: ${tx(item.code)}`);
      }
    }
  }

  const totalFmt = fmtTotal(payload.total);
  if (totalFmt) {
    lines.push(sepDash(), `<n>Total : ${totalFmt}</n>`);
  }
  if (payload.notes) {
    lines.push(sepDash(), `Obs: ${tx(payload.notes)}`);
  }
  if (payload.jobId) {
    lines.push(sepDash(), `Job: ${tx(payload.jobId).slice(0, 36)}`);
  }

  lines.push(sepEq(), tagCorte());
  return lines.filter(Boolean).join("\n") + "\n";
}

module.exports = {
  renderPedidoTags,
  normalizarPedidoPayload,
};
