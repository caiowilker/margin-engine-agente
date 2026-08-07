/**
 * Testes — pré-conta / rótulos pedido térmico
 */
const assert = require("assert");
const {
  normalizarPedidoPayload,
  tituloPedidoTermico,
  deveExibirTotalPedido,
  labelEventType,
} = require("../print/pedidoPrint");

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

console.log("pedido-pre-conta.test.js\n");

test("PRE_CONTA → título PRE-CONTA e exibe total", () => {
  assert.strictEqual(tituloPedidoTermico("cliente", "PRE_CONTA"), "PRE-CONTA");
  assert.strictEqual(deveExibirTotalPedido("cliente", "PRE_CONTA"), true);
  assert.strictEqual(labelEventType("PRE_CONTA"), "Pre-conta - cobranca");
  assert.ok(!labelEventType("PRE_CONTA").includes("?"));
  assert.ok(!/[^\x20-\x7E]/.test(labelEventType("PRE_CONTA")));
});

test("layout PRE-CONTA tem aviso nao-fiscal e TOTAL alinhado", () => {
  const { buildPedidoLayout } = require("../print/pedidoLayout");
  const { lines } = buildPedidoLayout({
    printType: "cliente",
    eventType: "PRE_CONTA",
    tableCode: "3",
    total: 20,
    items: [{ name: "Suco", quantity: 1, lineTotal: 20 }],
  });
  const texts = lines.map((l) => l.text || "").join("\n");
  assert.ok(texts.includes("PRE-CONTA"));
  assert.ok(texts.includes("nao e cupom fiscal"));
  assert.ok(texts.includes("MESA 3"));
  assert.ok(texts.includes("TOTAL"));
});

test("cozinha não exibe total", () => {
  assert.strictEqual(deveExibirTotalPedido("cozinha", "ORDER_UPDATED"), false);
});

test("normaliza unitPrice e lineTotal na pré-conta", () => {
  const p = normalizarPedidoPayload({
    printType: "cliente",
    eventType: "PRE_CONTA",
    total: 30,
    items: [
      { code: "1", name: "Item", quantity: 2, unitPrice: 15, lineTotal: 30 },
    ],
  });
  assert.strictEqual(p.eventType, "PRE_CONTA");
  assert.strictEqual(p.items[0].unitPrice, 15);
  assert.strictEqual(p.items[0].lineTotal, 30);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
