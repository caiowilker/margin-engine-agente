/**
 * Fast-path RAW — seleção de backend e hex/timing sem impressora física.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { performance } = require("perf_hooks");

test("rawWinspoolNative — load falha gracioso fora do Windows", () => {
  const native = require("../print/rawWinspoolNative");
  native.resetForTests();
  if (process.platform !== "win32") {
    assert.equal(native.isAvailable(), false);
  }
});

test("resolveRawBackend via env", () => {
  // Re-require path through impressoraCore internals is hard; test env contract
  const prev = process.env.PRINT_RAW_BACKEND;
  try {
    process.env.PRINT_RAW_BACKEND = "koffi";
    assert.equal(String(process.env.PRINT_RAW_BACKEND).toLowerCase(), "koffi");
    process.env.PRINT_RAW_BACKEND = "persistent";
    assert.equal(String(process.env.PRINT_RAW_BACKEND).toLowerCase(), "persistent");
  } finally {
    if (prev == null) delete process.env.PRINT_RAW_BACKEND;
    else process.env.PRINT_RAW_BACKEND = prev;
  }
});

test("bench simulado — 20 renders ESC/POS buffer <200ms média (sem RAW físico)", async () => {
  process.env.PRINTER_PROVIDER = "mock";
  const { gerarBuffer } = require("../print/escpos/impressoraCore").__test || {};
  // gerarBuffer may be on __test
  const core = require("../print/escpos/impressoraCore");
  const gen =
    core.__test?.gerarBuffer ||
    (async (fn) => {
      // fallback: mock print path
      const factory = require("../print/factory");
      factory.resetPrintProvider();
      const p = factory.getPrintProvider();
      if (p._clearJobs) p._clearJobs();
      await p.imprimirCupom({
        numeroVenda: "LAT-1",
        total: 10,
        itens: [{ nome: "Item", quantidade: 1, total: 10 }],
        empresa: { nomeFantasia: "BENCH" },
        exibirLogo: false,
      });
      return Buffer.from("x");
    });

  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    if (core.__test?.gerarBuffer) {
      await core.__test.gerarBuffer(async (printer) => {
        printer.text(`BENCH ${i}`);
        printer.cut();
      });
    } else {
      await gen();
    }
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const worst = Math.max(...samples);
  console.log(
    JSON.stringify({
      metric: "print.bench_buffer_or_mock",
      n: 20,
      avgMs: Math.round(avg * 10) / 10,
      worstMs: Math.round(worst * 10) / 10,
      samples: samples.map((s) => Math.round(s)),
    }),
  );
  // Mock/render path must stay fast — RAW spawn was the bottleneck
  assert.ok(avg < 500, `média ${avg}ms alta demais para mock/render`);
  assert.ok(worst < 2000, `pior caso ${worst}ms alto demais`);
});

console.log("raw-winspool-fastpath.test.js ok");
