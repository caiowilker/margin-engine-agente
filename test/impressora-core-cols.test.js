#!/usr/bin/env node
/**
 * Regressão impressão nativa ESC/POS:
 * - COLS TDZ no cabeçalho (cupom/fechamento)
 * - Render completo de cupom, fechamento, abertura e movimento
 */
const assert = require("assert");
const core = require("../print/escpos/impressoraCore");
const {
  __test: { renderCupomConteudo, renderFechamentoConteudo },
} = core;
const { classifyPrintError } = require("../print/printErrors");
const { renderFechamentoTags, renderAberturaTags } = require("../print/caixaAcbrTags");
const { renderCupomTags } = require("../print/cupomAcbrTags");

function mockPrinter() {
  const lines = [];
  const p = { lines };
  const chain = (...args) => {
    if (args.length) lines.push(String(args[0]));
    return p;
  };
  for (const m of [
    "font",
    "align",
    "style",
    "size",
    "text",
    "cut",
    "feed",
    "barcode",
    "control",
    "tableCustom",
    "drawLine",
  ]) {
    p[m] = m === "text" || m === "feed" || m === "cut" ? chain : () => p;
  }
  p.qrimage = (_c, _o, cb) => {
    if (typeof cb === "function") cb(null);
    return p;
  };
  return p;
}

const empresa = {
  nomeFantasia: "Loja Teste",
  razaoSocial: "Loja Teste LTDA",
  cnpj: "12345678000199",
  logradouro: "Rua A",
  numero: "100",
  bairro: "Centro",
  endereco: "Rua A, 100",
  cidade: "Sao Paulo",
  uf: "SP",
  telefone: "11999999999",
};

async function run() {
  console.log("impressora-core-cols.test.js\n");

  const p1 = mockPrinter();
  await renderCupomConteudo(p1, {
    naoFiscal: true,
    numeroVenda: "T-COLS",
    total: 10,
    desconto: 1,
    valorRecebido: 20,
    troco: 11,
    empresa,
    itens: [
      { nome: "Produto A com nome bem longo para quebrar linha", quantidade: 2, precoUnitario: 5, total: 10 },
      { nome: "Peso", quantidade: 0.5, precoUnitario: 20, total: 10, porPeso: true },
    ],
    pagamentos: [
      { forma: "dinheiro", valor: 15, troco: 5 },
      { forma: "pix", valor: 5, pixCopiaCola: "00020126..." },
    ],
  });
  assert.ok(p1.lines.some((l) => /CUPOM|TOTAL/i.test(l) || l.includes("TOTAL")));
  console.log("  ✓ renderCupomConteudo nao-fiscal completo");

  const p2 = mockPrinter();
  await renderCupomConteudo(p2, {
    chaveNfe: "35260712345678000199550010000000011000000010",
    numeroVenda: "NF-1",
    total: 10,
    empresa,
    itens: [{ nome: "Item", quantidade: 1, precoUnitario: 10, total: 10 }],
    pagamentos: [{ forma: "debito", valor: 10 }],
    urlConsulta: "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx",
  });
  console.log("  ✓ renderCupomConteudo fiscal (chave) sem TDZ COLS");

  const p3 = mockPrinter();
  await renderFechamentoConteudo(p3, {
    numeroCaixa: "12",
    operador: "Op",
    aberturaEm: "01/01/2026 08:00",
    fechamentoEm: "01/01/2026 18:00",
    minutosAberto: 600,
    quantidadeVendas: 3,
    totalVendas: 150,
    totalLucro: 30,
    margemMedia: 20,
    valorAbertura: 100,
    valorContado: 250,
    diferenca: 0,
    observacao: "Ok",
    empresa: { nome: "Loja", ...empresa },
    resumoPorForma: {
      dinheiro: { total: 50, quantidade: 1 },
      pix: { total: 100, quantidade: 2 },
    },
  });
  assert.ok(p3.lines.some((l) => /FECHAMENTO/i.test(l)));
  console.log("  ✓ renderFechamentoConteudo completo com endereco");

  // Tags ACBr (caminho preferencial quando FFI ok) tambem usam COLS no cabecalho
  const tagsCupom = renderCupomTags({
    naoFiscal: true,
    numeroVenda: "T-1",
    total: 5,
    empresa,
    itens: [{ nome: "X", quantidade: 1, precoUnitario: 5, total: 5 }],
  });
  assert.ok(tagsCupom.includes("CUPOM") || tagsCupom.includes("NAO FISCAL"));
  console.log("  ✓ renderCupomTags ACBr");

  const tagsFecha = renderFechamentoTags({
    empresa: { nome: "Loja", ...empresa },
    numeroCaixa: "1",
    totalVendas: 10,
    quantidadeVendas: 1,
    fechamentoEm: "agora",
  });
  assert.ok(tagsFecha.includes("FECHAMENTO"));
  console.log("  ✓ renderFechamentoTags ACBr");

  const tagsAbre = renderAberturaTags({
    empresa: { nome: "Loja", cnpj: empresa.cnpj },
    valorAbertura: 50,
  });
  assert.ok(tagsAbre.includes("ABERTURA"));
  console.log("  ✓ renderAberturaTags ACBr");

  const ffiCls = classifyPrintError(new Error("Cannot find module 'koffi'"));
  assert.equal(ffiCls.fallbackSuggested, true);
  const colsCls = classifyPrintError(new Error("Cannot access 'COLS' before initialization"));
  assert.equal(colsCls.fallbackSuggested, true);
  console.log("  ✓ classifyPrintError sugere fallback para ffi/COLS");

  console.log("\nOK");
}

run().catch((e) => {
  console.error("FALHA:", e && e.stack ? e.stack : e);
  process.exit(1);
});
