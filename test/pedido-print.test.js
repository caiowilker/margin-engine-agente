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

test("renderPedidoTags cozinha usa badge ALTERADO na edicao do pedido (lista completa, obs ALTERADO)", () => {
  const tags = renderPedidoTags({
    printType: "cozinha",
    eventType: "ORDER_EDITED",
    orderNumber: "ORD-2",
    notes: "ALTERADO: Itens: Pizza 1->2",
    items: [
      { name: "Pizza", quantity: 2, unit: "un" },
      { name: "Suco", quantity: 1, unit: "un" },
    ],
  });
  assert.ok(tags.includes("ALTERADO"));
  assert.ok(!tags.includes("ADICIONAL"));
  assert.ok(tags.includes("PIZZA") && tags.includes("SUCO"));
});

test("renderPedidoTags cozinha usa badge REIMPRESSÃO na reimpressão da central", () => {
  const tags = renderPedidoTags({
    printType: "cozinha",
    eventType: "ORDER_REPRINTED",
    orderNumber: "ORD-3",
    notes: "REIMPRESSÃO por Ana às 12:00:00",
    items: [{ name: "Pizza", quantity: 1, unit: "un" }],
  });
  assert.ok(tags.includes("REIMPRESSAO"));
  assert.ok(!tags.includes("NOVO"));
  assert.ok(tags.includes("PIZZA"));
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

test("comanda entrega com pagamento dividido imprime uma forma por linha", () => {
  const tags = renderPedidoTags({
    printType: "entrega",
    eventType: "ORDER_CREATED",
    orderNumber: "ORD-8",
    customerName: "Bia",
    deliveryAddress: "Rua D, 10 — Centro, Campinas — SP",
    paymentForm: "Dinheiro R$ 30,00 (troco p/ R$ 50,00) + Cartão R$ 20,00",
    cashChangeFor: 50,
    changeAmount: 20,
    total: 50,
    items: [{ name: "Pizza", quantity: 1, unit: "un" }],
  });
  const linhas = tags.split("\n");
  assert.ok(linhas.some((l) => l.includes("DINHEIRO R$ 30,00 (TROCO P/ R$ 50,00)") && !l.includes("CARTAO")));
  assert.ok(linhas.some((l) => l.includes("CARTAO R$ 20,00") && !l.includes("DINHEIRO")));
  assert.ok(tags.includes("Troco para"));
});

test("comanda entrega inclui motoboy e horario legivel", () => {
  const tags = renderPedidoTags({
    printType: "entrega",
    eventType: "ORDER_READY",
    orderNumber: "ORD-7",
    customerName: "Lia",
    customerPhone: "11911112222",
    courierName: "Carlos",
    deliveryAddress: "Rua C, 30 — Centro, Campinas — SP — CEP 13010-100",
    paymentForm: "PIX_LOCAL",
    deliveryFee: 5,
    total: 40,
    createdAt: "2026-08-17T17:35:00",
    items: [
      { name: "X-Burger", quantity: 2, unit: "UN", unitPrice: 15, lineTotal: 30, notes: "sem cebola" },
    ],
  });
  assert.ok(tags.includes("Motoboy"));
  assert.ok(tags.includes("Carlos"));
  assert.ok(tags.includes("PIX na entrega"));
  assert.ok(tags.includes("17/08 17:35"));
  assert.ok(tags.includes("sem cebola"));
  assert.ok(tags.includes("30,00"));
});

test("comanda converte ISO UTC (Z) para horário da loja", () => {
  const { formatCreatedAtForPrint } = require("../print/pedidoPrint");
  assert.equal(formatCreatedAtForPrint("2026-08-17T20:35:00.000Z"), "17/08 17:35");
  assert.equal(formatCreatedAtForPrint("2026-08-17T17:35:00"), "17/08 17:35");
  assert.equal(formatCreatedAtForPrint("17/08/2026, 17:35:00"), "17/08 17:35");
});

test("comanda entrega imprime taxa de entrega antes do TOTAL", () => {
  const tags = renderPedidoTags({
    printType: "entrega",
    eventType: "ORDER_CREATED",
    orderNumber: "ORD-8",
    customerName: "Ana",
    deliveryAddress: "Rua B, 20",
    deliveryFee: 7.5,
    total: 47.5,
    items: [{ name: "Coca 2L", quantity: 1, unit: "un" }],
  });
  assert.ok(tags.includes("Taxa de entrega"));
  assert.ok(tags.includes("7,50"));
  assert.ok(tags.includes("TOTAL"));
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

test("escolhas das listas: lista ou texto por linha, impressas abaixo do item", () => {
  const p = normalizarPedidoPayload({
    orderNumber: "ORD-4",
    printType: "cozinha",
    items: [
      { name: "Pizza G", quantity: 1, escolhas: ["Sabores: 1/2 Calabresa, 1/2 Frango", " ", "Borda: Catupiry"] },
      { name: "Suco", quantity: 1, escolhas: "Fruta: Laranja\n" },
      { name: "Agua", quantity: 1 },
    ],
  });
  assert.deepStrictEqual(p.items[0].escolhas, ["Sabores: 1/2 Calabresa, 1/2 Frango", "Borda: Catupiry"]);
  assert.deepStrictEqual(p.items[1].escolhas, ["Fruta: Laranja"]);
  assert.deepStrictEqual(p.items[2].escolhas, []);

  const { lines } = buildPedidoLayout({
    printType: "cozinha",
    orderNumber: "4",
    items: [{ name: "Pizza G", quantity: 1, escolhas: ["Borda: Catupiry"], notes: "bem assada" }],
  });
  const textos = lines.map((l) => l.text || "");
  const iEscolha = textos.findIndex((t) => t.includes("Borda: Catupiry"));
  const iObs = textos.findIndex((t) => t.includes("bem assada"));
  assert.ok(iEscolha > 0, "escolha impressa");
  assert.ok(iObs > iEscolha, "observação depois das escolhas");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
