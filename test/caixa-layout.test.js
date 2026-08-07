#!/usr/bin/env node
/**
 * Layouts de caixa — abertura / fechamento / suprimento / sangria
 */
const assert = require("assert");
const {
  buildAberturaLayout,
  buildFechamentoLayout,
  buildMovimentoLayout,
} = require("../print/caixaLayout");
const {
  renderAberturaTags,
  renderFechamentoTags,
  renderMovimentoCaixaTags,
} = require("../print/caixaAcbrTags");

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

console.log("caixa-layout.test.js\n");

test("abertura: titulo + fundo destacado", () => {
  const text = plain(
    buildAberturaLayout({
      empresa: { nome: "Loja Teste", cnpj: "12345678000199" },
      operador: "Maria",
      numeroCaixa: "1",
      aberturaEm: "07/08/2026 08:00",
      valorAbertura: 150,
      exibirLogo: false,
    }),
  );
  assert.ok(text.includes("ABERTURA DE CAIXA"));
  assert.ok(text.includes("FUNDO DE CAIXA"));
  assert.ok(text.includes("R$ 150,00"));
  assert.ok(text.includes("Maria"));
  assert.ok(text.includes("LOJA TESTE"));
});

test("sangria: valor grande + saldo apos", () => {
  const text = plain(
    buildMovimentoLayout({
      tipo: "sangria",
      valor: 80,
      motivo: "Troco banco",
      operador: "Joao",
      saldoAtual: 70,
      emitidoEm: "07/08/2026 12:00",
      exibirLogo: false,
    }),
  );
  assert.ok(text.includes("SANGRIA DE CAIXA"));
  assert.ok(text.includes("Retirada de numerario"));
  assert.ok(text.includes("R$ 80,00"));
  assert.ok(text.includes("Troco banco"));
  assert.ok(text.includes("Saldo apos"));
  assert.ok(text.includes("R$ 70,00"));
});

test("suprimento: entrada de numerario", () => {
  const text = plain(
    buildMovimentoLayout({
      tipo: "suprimento",
      valor: 50,
      motivo: "Fundo extra",
      operador: "Ana",
      saldoAtual: 200,
      emitidoEm: "07/08/2026 10:00",
      exibirLogo: false,
    }),
  );
  assert.ok(text.includes("SUPRIMENTO DE CAIXA"));
  assert.ok(text.includes("Entrada de numerario"));
  assert.ok(text.includes("R$ 50,00"));
});

test("fechamento: formas alinhadas + conferencia sobra/falta + sangrias", () => {
  const text = plain(
    buildFechamentoLayout({
      empresa: { nome: "PDV Central", cnpj: "11222333000181" },
      operador: "Maria",
      aberturaEm: "08:00",
      fechamentoEm: "18:00",
      minutosAberto: 600,
      quantidadeVendas: 12,
      totalVendas: 1234.5,
      resumoPorForma: {
        dinheiro: { total: 400, quantidade: 5 },
        pix: { total: 834.5, quantidade: 7 },
      },
      valorAbertura: 100,
      totalSuprimentos: 50,
      totalSangrias: 30,
      valorContado: 520,
      diferenca: 0,
      exibirLogo: false,
    }),
  );
  assert.ok(text.includes("FECHAMENTO DE CAIXA"));
  assert.ok(text.includes("RESUMO DO TURNO"));
  assert.ok(text.includes("FORMAS DE PAGAMENTO"));
  assert.ok(text.includes("Dinheiro"));
  assert.ok(text.includes("PIX"));
  assert.ok(text.includes("CONFERENCIA"));
  assert.ok(text.includes("Suprimentos (+)"));
  assert.ok(text.includes("Sangrias (-)"));
  assert.ok(text.includes("OK - confere"));
  assert.ok(text.includes("10h 00min"));
});

test("fechamento falta deixa Falta explicito", () => {
  const text = plain(
    buildFechamentoLayout({
      operador: "X",
      fechamentoEm: "18:00",
      quantidadeVendas: 1,
      totalVendas: 10,
      valorAbertura: 0,
      valorContado: 5,
      diferenca: -5,
      exibirLogo: false,
    }),
  );
  assert.ok(text.includes("Falta"));
  assert.ok(text.includes("R$ 5,00"));
  assert.ok(!text.includes("OK - confere"));
});

test("tags ACBr abertura contem expandido", () => {
  const tags = renderAberturaTags({
    operador: "Maria",
    valorAbertura: 10,
    aberturaEm: "agora",
    exibirLogo: false,
  });
  assert.ok(tags.includes("ABERTURA DE CAIXA"));
  assert.ok(tags.includes("<e>"));
  assert.ok(tags.includes("</corte"));
});

test("tags movimento e fechamento geram corte", () => {
  assert.ok(renderMovimentoCaixaTags({ tipo: "sangria", valor: 1, saldoAtual: 1, emitidoEm: "x", operador: "a", exibirLogo: false }).includes("SANGRIA"));
  assert.ok(renderFechamentoTags({ operador: "a", fechamentoEm: "x", quantidadeVendas: 0, totalVendas: 0, valorContado: 0, diferenca: 0, exibirLogo: false }).includes("FECHAMENTO"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
