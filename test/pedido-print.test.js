#!/usr/bin/env node
const assert = require("assert");
const { normalizarPedidoPayload, labelPrintType } = require("../print/pedidoPrint");
const { renderPedidoTags } = require("../print/pedidoAcbrTags");
const { validarAntesEnfileirar } = require("../print/printValidate");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("pedido-print.test.js\n");

test("normalizarPedidoPayload aceita snake_case do backend", () => {
  const p = normalizarPedidoPayload({
    job_id: "abc-123",
    print_type: "cozinha",
    event_type: "ORDER_CREATED",
    order_number: "ORD-9",
    order_id: "uuid-1",
    table_code: "M12",
    customer_name: "Maria",
    total: 42.5,
    copies: 2,
    items: [{ code: "1", name: "Cafe", quantity: 2, unit: "un" }],
  });
  assert.strictEqual(p.jobId, "abc-123");
  assert.strictEqual(p.printType, "cozinha");
  assert.strictEqual(p.orderNumber, "ORD-9");
  assert.strictEqual(p.tableCode, "M12");
  assert.strictEqual(p.copies, 2);
  assert.strictEqual(p.items[0].name, "Cafe");
});

test("renderPedidoTags inclui estação e itens", () => {
  const tags = renderPedidoTags({
    printType: "bar",
    eventType: "ORDER_CREATED",
    orderNumber: "ORD-1",
    items: [{ name: "Suco", quantity: 1, unit: "un" }],
  });
  assert.ok(tags.includes("BAR"));
  assert.ok(tags.includes("ORD-1"));
  assert.ok(tags.includes("Suco"));
});

test("validarAntesEnfileirar rejeita pedido sem identificador", () => {
  assert.throws(
    () => validarAntesEnfileirar("imprimirPedido", [{}]),
    /identificador/,
  );
});

test("validarAntesEnfileirar aceita orderNumber", () => {
  const r = validarAntesEnfileirar("imprimirPedido", [
    { orderNumber: "ORD-2", printType: "cozinha", items: [] },
  ]);
  assert.strictEqual(r.args[0].orderNumber, "ORD-2");
});

test("labelPrintType cobre tipos do Order Engine", () => {
  assert.strictEqual(labelPrintType("entrega"), "ENTREGA");
  assert.strictEqual(labelPrintType("producao"), "PRODUCAO");
});

test("normalizarPedidoPayload preserva notes do item", () => {
  const p = normalizarPedidoPayload({
    orderNumber: "ORD-3",
    printType: "cozinha",
    items: [{ name: "Burger", quantity: 1, notes: "sem cebola" }],
  });
  assert.strictEqual(p.items[0].notes, "sem cebola");
});

test("renderPedidoTags imprime observação do item e omite total na cozinha", () => {
  const tags = renderPedidoTags({
    printType: "cozinha",
    eventType: "ORDER_CREATED",
    orderNumber: "ORD-4",
    total: 99.9,
    items: [{ name: "Burger", quantity: 1, notes: "sem cebola" }],
  });
  assert.ok(tags.includes("sem cebola"));
  assert.ok(!tags.includes("Total :"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
