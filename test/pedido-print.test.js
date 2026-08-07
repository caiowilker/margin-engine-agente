#!/usr/bin/env node
const assert = require("assert");
const { normalizarPedidoPayload, labelPrintType, labelPaymentForm } = require("../print/pedidoPrint");
const { renderPedidoTags } = require("../print/pedidoAcbrTags");
const { buildPedidoLayout, fmtQtyKitchen } = require("../print/pedidoLayout");
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
    customer_phone: "11999998888",
    delivery_address: "Rua A, 10 — Centro, SP — CEP 01310-100",
    total: 42.5,
    copies: 2,
    items: [{ code: "1", name: "Cafe", quantity: 2, unit: "un" }],
  });
  assert.strictEqual(p.jobId, "abc-123");
  assert.strictEqual(p.printType, "cozinha");
  assert.strictEqual(p.orderNumber, "ORD-9");
  assert.strictEqual(p.tableCode, "M12");
  assert.strictEqual(p.customerPhone, "(11) 99999-8888");
  assert.strictEqual(p.deliveryAddress, "Rua A, 10 — Centro, SP — CEP 01310-100");
  assert.strictEqual(p.copies, 2);
  assert.strictEqual(p.items[0].name, "Cafe");
});

test("renderPedidoTags cozinha: MESA grande, qty 2x, sem total/SKU/logo job", () => {
  const tags = renderPedidoTags({
    printType: "cozinha",
    eventType: "ORDER_CREATED",
    orderNumber: "ORD-4",
    tableCode: "12",
    total: 99.9,
    jobId: "job-xyz-should-not-print",
    items: [{ code: "SKU1", name: "Burger", quantity: 2, unit: "UN", notes: "sem cebola" }],
  });
  assert.ok(tags.includes("COZINHA"));
  assert.ok(tags.includes("NOVO"));
  assert.ok(tags.includes("MESA 12"));
  assert.ok(tags.includes("2x") && tags.includes("BURGER"));
  assert.ok(tags.includes("sem cebola"));
  assert.ok(!tags.includes("TOTAL"));
  assert.ok(!tags.includes("Total"));
  assert.ok(!tags.includes("SKU1"));
  assert.ok(!tags.includes("Cod:"));
  assert.ok(!tags.includes("job-xyz"));
});

test("renderPedidoTags bar usa badge ADICIONAL em update", () => {
  const tags = renderPedidoTags({
    printType: "bar",
    eventType: "ORDER_UPDATED",
    orderNumber: "ORD-1",
    items: [{ name: "Suco", quantity: 1, unit: "un" }],
  });
  assert.ok(tags.includes("BAR"));
  assert.ok(tags.includes("ADICIONAL"));
  assert.ok(tags.includes("1x") && tags.includes("SUCO"));
});

test("renderPedidoTags entrega: tel, endereco, pagto, troco, TOTAL", () => {
  const tags = renderPedidoTags({
    printType: "entrega",
    eventType: "ORDER_READY",
    orderNumber: "ORD-5",
    customerName: "Joao",
    customerPhone: "11988887777",
    deliveryAddress: "Rua das Flores, 120 — Apto 42 — Centro, Sao Paulo — SP — CEP 01310-100",
    paymentForm: "CASH",
    cashChangeFor: 50,
    changeAmount: 5,
    total: 55,
    items: [{ name: "Pizza", quantity: 1, unit: "un" }],
  });
  assert.ok(tags.includes("ENTREGA"));
  assert.ok(tags.includes("Joao"));
  assert.ok(tags.includes("(11) 98888-7777"));
  assert.ok(tags.includes("ENDERECO"));
  assert.ok(tags.includes("Rua das Flores"));
  assert.ok(tags.includes("Apto 42"));
  assert.ok(tags.includes("Dinheiro"));
  assert.ok(tags.includes("Troco para"));
  assert.ok(tags.includes("TOTAL"));
  assert.ok(!tags.includes("Levar"));
});

test("labelPaymentForm normaliza CASH/CARD", () => {
  assert.strictEqual(labelPaymentForm("CASH"), "Dinheiro");
  assert.strictEqual(labelPaymentForm("CARD"), "Cartao");
  assert.strictEqual(labelPaymentForm("PIX_LOCAL"), "PIX na entrega");
});

test("fmtQtyKitchen omite UN", () => {
  assert.strictEqual(fmtQtyKitchen(2, "UN"), "2x");
  assert.strictEqual(fmtQtyKitchen(1.5, "KG"), "1,5 KG");
});

test("buildPedidoLayout cozinha nao pede logo por padrao", () => {
  const { showLogo } = buildPedidoLayout({
    printType: "cozinha",
    orderNumber: "1",
    items: [{ name: "A", quantity: 1 }],
  });
  assert.strictEqual(showLogo, false);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
