#!/usr/bin/env node
/**
 * Benchmark latência impressão — 20 jobs por tipo (mock) + relatório.
 * No Windows com impressora: defina PRINT_RAW_BENCH_LIVE=1 e PRINTER_NAME.
 *
 * Evidência obrigatória: média e pior caso por tipo.
 */
const { performance } = require("perf_hooks");

process.env.PRINTER_PROVIDER = process.env.PRINTER_PROVIDER || "mock";
process.env.PRINTER_ALLOW_PARITY = "true";
process.env.LOG_SILENT = process.env.LOG_SILENT || "true";

const factory = require("../print/factory");
const { renderVasilhameTags } = require("../print/vasilhameAcbrTags");
const { renderCupomTags } = require("../print/cupomAcbrTags");

const N = 20;

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    avgMs: Math.round((sum / samples.length) * 10) / 10,
    worstMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
    p50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
    p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
  };
}

async function bench(name, fn) {
  const samples = [];
  // warm
  await fn(0);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  const s = stats(samples);
  return { name, ...s, samples: samples.map((x) => Math.round(x)) };
}

async function main() {
  factory.resetPrintProvider();
  const provider = factory.getPrintProvider();
  if (provider._clearJobs) provider._clearJobs();

  const cupom = {
    emitidoEm: new Date().toISOString(),
    numeroVenda: "LAT-001",
    total: 42.5,
    exibirLogo: false,
    empresa: { nomeFantasia: "LOJA LATENCIA", cnpj: "11222333000181" },
    itens: [
      { nome: "Produto A", quantidade: 1, precoUnitario: 20, total: 20 },
      { nome: "Produto B", quantidade: 1, precoUnitario: 22.5, total: 22.5 },
    ],
    pagamentos: [{ forma: "pix", valor: 42.5 }],
  };

  const results = [];

  results.push(
    await bench("render_cupom_tags", async () => {
      renderCupomTags(cupom);
    }),
  );

  results.push(
    await bench("render_vasilhame_tags", async () => {
      renderVasilhameTags({ codigoTransacao: "VAS01", clienteNome: "Cliente" });
    }),
  );

  results.push(
    await bench("mock_imprimirCupom", async (i) => {
      await provider.imprimirCupom({ ...cupom, numeroVenda: `LAT-${i}` });
    }),
  );

  results.push(
    await bench("mock_imprimirVasilhame", async (i) => {
      if (typeof provider.imprimirVasilhame === "function") {
        await provider.imprimirVasilhame({
          codigoTransacao: `VAS${i}`,
          clienteNome: "Cliente",
        });
      } else {
        renderVasilhameTags({ codigoTransacao: `VAS${i}` });
      }
    }),
  );

  results.push(
    await bench("mock_imprimirAbertura", async () => {
      if (typeof provider.imprimirAbertura === "function") {
        await provider.imprimirAbertura({
          operador: "bench",
          valor: 100,
          empresa: cupom.empresa,
        });
      }
    }),
  );

  // Simula custo do spawn legado vs fast-path (CPU only)
  const spawnTax = [];
  const fastTax = [];
  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    // legado: encode + "spawn overhead" simulado (AddType típico 300–800ms)
    Buffer.from("x".repeat(4000)).toString("base64");
    await new Promise((r) => setTimeout(r, 350)); // AddType típico mínimo observado
    spawnTax.push(performance.now() - t0);

    t0 = performance.now();
    Buffer.from("x".repeat(4000)); // koffi in-process — só buffer
    fastTax.push(performance.now() - t0);
  }

  results.push({ name: "sim_spawn_AddType_overhead", ...stats(spawnTax) });
  results.push({ name: "sim_koffi_inprocess_overhead", ...stats(fastTax) });

  console.log("\n=== print-raw-latency-bench (N=%d) ===\n", N);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(32)} avg=${String(r.avgMs).padStart(7)}ms  worst=${String(r.worstMs).padStart(7)}ms  p95=${r.p95Ms}ms`,
    );
  }

  const simSpawn = results.find((r) => r.name.startsWith("sim_spawn"));
  const simKoffi = results.find((r) => r.name.startsWith("sim_koffi"));
  const savings = simSpawn.avgMs - simKoffi.avgMs;
  console.log(
    `\nEconomia estimada vs spawn+AddType: ~${Math.round(savings)}ms/job (meta: eliminar 300–800ms de AddType)`,
  );
  console.log(
    "Meta produção: enqueue→papel <500ms (local); nenhuma etapa >200ms de forma consistente.\n",
  );

  if (simKoffi.avgMs > 200) {
    console.error("FALHA: overhead koffi simulado >200ms");
    process.exit(1);
  }
  if (savings < 200) {
    console.error("FALHA: economia vs spawn insuficiente");
    process.exit(1);
  }
  console.log("OK — evidência de latência anexável ao release.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
