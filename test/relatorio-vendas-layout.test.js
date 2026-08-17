#!/usr/bin/env node
/**
 * Relatório térmico de vendas selecionadas — layout + validação.
 */
const assert = require("assert");
const {
  buildRelatorioVendasLayout,
  normalizarRelatorioVendasPayload,
} = require("../print/relatorioVendasLayout");
const { renderRelatorioVendasTags } = require("../print/relatorioVendasAcbrTags");
const { validarAntesEnfileirar } = require("../print/printValidate");
const { resolverTipo, TIPOS } = require("../print/printJobTypes");

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

function plain(layout) {
  return layout.lines
    .map((l) => {
      if (l.kind === "blank") return "";
      return l.text || "";
    })
    .join("\n");
}

const payloadMin = {
  operador: "Maria",
  empresa: { nome: "Mercado Teste", cnpj: "11222333000181" },
  impressoEm: "17/08/2026 14:00",
  periodoDe: "17/08/2026 08:00",
  periodoAte: "17/08/2026 14:00",
  quantidadeVendas: 2,
  faturamento: 25.5,
  vendas: [
    {
      numero: "V1",
      emitidoEm: "17/08/2026 09:00",
      total: 10.0,
      subtotal: 10,
      desconto: 0,
      operador: "Maria",
      cliente: "Joao",
      documento: "12345678901",
      formas: [{ forma: "dinheiro", valor: 10 }],
      itens: [
        { codigo: "A", nome: "Pao", quantidade: 2, precoUnitario: 3, total: 6, unidade: "un" },
        { codigo: "C", nome: "Cafe", quantidade: 1, precoUnitario: 4, total: 4 },
      ],
    },
    {
      numero: "V2",
      emitidoEm: "17/08/2026 10:00",
      total: 15.5,
      formas: [{ forma: "pix", valor: 15.5 }],
      itens: [{ codigo: "B", nome: "Leite", quantidade: 1, precoUnitario: 15.5, total: 15.5 }],
    },
  ],
  itens: [
    { codigo: "B", nome: "Leite", quantidade: 1, total: 15.5 },
    { codigo: "A", nome: "Pao", quantidade: 2, total: 6.0 },
    { codigo: "C", nome: "Cafe", quantidade: 1, total: 4 },
  ],
  resumoPorForma: {
    dinheiro: { total: 10, quantidade: 1 },
    pix: { total: 15.5, quantidade: 1 },
  },
  clickId: "click-1",
};

console.log("relatorio-vendas-layout.test.js\n");

test("rejeita sem operador / sem vendas / sem itens", () => {
  assert.throws(() => normalizarRelatorioVendasPayload({ vendas: [{}], itens: [{}] }));
  assert.throws(() =>
    normalizarRelatorioVendasPayload({ operador: "x", vendas: [], itens: [{}] }),
  );
  assert.throws(() =>
    normalizarRelatorioVendasPayload({
      operador: "x",
      vendas: [{ numero: "1" }],
      itens: [],
    }),
  );
});

test("layout traz cada venda com produtos, unitario e consolidado", () => {
  const layout = buildRelatorioVendasLayout(payloadMin);
  const t = plain(layout);
  assert.ok(t.includes("RELATORIO DE VENDAS"));
  assert.ok(t.includes("Comprovante nao fiscal"));
  assert.ok(t.includes("MERCADO TESTE") || t.includes("Mercado"));
  assert.ok(t.includes("VENDA V1"));
  assert.ok(t.includes("VENDA V2"));
  assert.ok(t.includes("Pao") || t.includes("PAO"));
  assert.ok(t.includes("Leite") || t.includes("LEITE"));
  assert.ok(t.includes("Cafe") || t.includes("CAFE"));
  assert.ok(t.includes("Joao") || t.includes("JOAO"));
  assert.ok(t.includes("CONSOLIDADO"));
  assert.ok(t.includes("PIX") || t.includes("Pix"));
  assert.ok(/25[,.]50/.test(t));
  assert.ok(t.includes("Nao substitui") || t.includes("nao fiscal"));
});

test("aceita itens so nos blocos das vendas (sem lista consolidada no payload)", () => {
  const { itens: _omit, ...semConsolidado } = payloadMin;
  const layout = buildRelatorioVendasLayout(semConsolidado);
  const t = plain(layout);
  assert.ok(t.includes("Pao") || t.includes("PAO"));
  assert.ok(t.includes("VENDA V1"));
});

test("tags ACBr espelham o layout", () => {
  const tags = renderRelatorioVendasTags({ ...payloadMin, exibirLogo: false });
  assert.ok(tags.includes("</zera>"));
  assert.ok(tags.includes("RELATORIO DE VENDAS"));
  assert.ok(tags.includes("<n>"));
  assert.ok(tags.includes("</corte"));
});

test("fila — tipo relatorio + validate", () => {
  assert.equal(resolverTipo("imprimirRelatorio", payloadMin), TIPOS.RELATORIO);
  const r = validarAntesEnfileirar("imprimirRelatorio", [payloadMin]);
  assert.equal(r.ok, true);
  assert.equal(r.args[0].operador, "Maria");
});

if (failed) {
  console.error(`\n${failed} falha(s), ${passed} ok`);
  process.exit(1);
}
console.log(`\n${passed} testes — OK`);
