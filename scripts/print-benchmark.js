#!/usr/bin/env node
/**
 * Benchmark impressão — render tags + mock provider (CI/Linux).
 * Compara ACBr tags vs baseline; falha se regressão > limite.
 */
const assert = require("assert");
const { performance } = require("perf_hooks");

process.env.PRINTER_PROVIDER = "mock";
process.env.PRINTER_ALLOW_PARITY = "true";

const { renderCupomTags, renderPaginaTeste } = require("../print/cupomAcbrTags");
const { renderDanfeTermicoTags } = require("../print/danfeTermico");
const { renderPayloadTags } = require("../print/renderPrint");
const factory = require("../print/factory");

const ITER_RENDER = 200;
const ITER_PRINT = 80;
const MAX_REGRESSAO_PCT = 25;

function bench(name, fn, iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - t0;
  return { name, iterations, totalMs: ms, avgMs: ms / iterations };
}

const cupomPayload = {
  emitidoEm: new Date().toISOString(),
  numeroVenda: "BENCH-001",
  total: 123.45,
  desconto: 3.45,
  empresa: { nomeFantasia: "LOJA BENCHMARK", cnpj: "11222333000181", cidade: "BH", uf: "MG" },
  itens: Array.from({ length: 12 }, (_, i) => ({
    nome: `Produto benchmark ${i + 1}`,
    quantidade: i + 1,
    precoUnitario: 10,
    total: (i + 1) * 10,
  })),
  pagamentos: [
    { forma: "pix", valor: 60, pixCopiaCola: "00020126580014br.gov.bcb.pix0136bench" },
    { forma: "dinheiro", valor: 70, troco: 6.55 },
  ],
  chaveNfe: "35260611222333000181650010000000301025012345",
  qrcodeNfe: "https://example.com/nfce-bench",
  ean13: "7894900011517",
  code128: "BENCH128",
};

async function run() {
  console.log("print-benchmark.js\n");

  const results = [];

  results.push(
    bench("renderCupomTags", () => renderCupomTags(cupomPayload), ITER_RENDER),
  );
  results.push(bench("renderPaginaTeste", () => renderPaginaTeste(), Math.floor(ITER_RENDER / 2)));
  results.push(
    bench(
      "renderDanfeTermicoTags",
      () =>
        renderDanfeTermicoTags({
          ...cupomPayload,
          danfeTermico: true,
          destinatario: { razaoSocial: "CLIENTE BENCH", cpfCnpj: "12345678909" },
        }),
      Math.floor(ITER_RENDER / 2),
    ),
  );
  results.push(bench("renderPayloadTags", () => renderPayloadTags(cupomPayload), ITER_RENDER));

  factory.resetPrintProvider();
  const mock = factory.getPrintProvider();
  mock._clearJobs();

  const tPrint0 = performance.now();
  for (let i = 0; i < ITER_PRINT; i++) {
    await mock.imprimirCupom({ ...cupomPayload, numeroVenda: `B-${i}` });
  }
  const printMs = performance.now() - tPrint0;
  results.push({
    name: "mockImprimirCupom",
    iterations: ITER_PRINT,
    totalMs: printMs,
    avgMs: printMs / ITER_PRINT,
  });

  const baseline = results.find((r) => r.name === "renderCupomTags");
  for (const r of results) {
    if (r.name === "renderPayloadTags" && baseline) {
      const regressao = ((r.avgMs - baseline.avgMs) / baseline.avgMs) * 100;
      assert.ok(
        regressao <= MAX_REGRESSAO_PCT,
        `renderPayloadTags regressão ${regressao.toFixed(1)}% > ${MAX_REGRESSAO_PCT}%`,
      );
    }
    console.log(
      `  ${r.name}: ${r.iterations}x total=${r.totalMs.toFixed(1)}ms avg=${r.avgMs.toFixed(3)}ms`,
    );
  }

  assert.strictEqual(mock._jobs.length, ITER_PRINT);

  const outPath = require("path").join(__dirname, "..", "data", "benchmark-print.json");
  require("fs").mkdirSync(require("path").dirname(outPath), { recursive: true });
  require("fs").writeFileSync(
    outPath,
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
    "utf8",
  );

  console.log(`\nBenchmark OK — resultados em ${outPath}\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
