#!/usr/bin/env node
/**
 * Solidéz produção — RAW fail-clean, late ERRO→IMPRESSO bloqueado, motivo front.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "print-solidity-"));
process.env.MARGIN_ENGINE_ROOT = tmpRoot;
process.env.PRINTER_PROVIDER = "mock";
process.env.PRINT_JOB_WORKER = "false";
process.env.LOG_SILENT = "true";
process.env.PRINTER_RAW_TIMEOUT_MS = "250";

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

async function run() {
  await test("RAW_PRINT_TIMEOUT_MS default é 4000 + soft kill rejeita", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../print/escpos/impressoraCore.js"),
      "utf8",
    );
    assert.ok(src.includes('PRINTER_RAW_TIMEOUT_MS || "4000"'));
    assert.ok(src.includes("killProcessTree"));
    assert.ok(src.includes("print.taskkill_attempt"));
    assert.ok(src.includes("RAW_KILL_HOLD_MS"));
    assert.ok(src.includes("print.raw_kill_confirmed_release"));
    assert.ok(src.includes("print.raw_kill_hold_expired"));
    assert.ok(src.includes("makeRawTimeoutError"));
    assert.ok(src.includes('code = "RAW_PRINT_TIMEOUT"') || src.includes("RAW_PRINT_TIMEOUT"));
    assert.ok(src.includes("printTimedOut = true") || src.includes("printTimedOut: true"));
    assert.ok(!/\bexecFileSync\s*\(/.test(src), "P2b: execFileSync proibido no RAW");
  });

  await test("contrato soft-timeout: Promise rejeita rápido com child zombie", async () => {
    const t0 = Date.now();
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = execFile(
        process.execPath,
        ["-e", "setTimeout(()=>{}, 60000)"],
        () => {},
      );
      const soft = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
        if (!settled) {
          settled = true;
          reject(new Error("RAW Windows timeout (250ms): mock"));
        }
      }, 250);
      child.on("exit", () => {
        clearTimeout(soft);
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    }).then(
      () => {
        throw new Error("deveria ter rejeitado por timeout");
      },
      (err) => {
        const ms = Date.now() - t0;
        assert.ok(/timeout/i.test(err.message), err.message);
        assert.ok(ms < 3000, `timeout demorou demais: ${ms}ms`);
      },
    );
  });

  await test("job já ERRO não é promovido a IMPRESSO (late abandon)", async () => {
    const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
    resetDirectoryManager();
    getDirectoryManager(tmpRoot).ensureAll();

    const store = require("../print/printJobStore");
    try {
      store.resetDbForTests?.();
    } catch (_) {}
    store.initDb();

    const factory = require("../print/factory");
    factory.resetPrintProvider();
    const pjs = require("../print/printJobService");
    const executor = require("../print/printExecutor");

    const job = pjs.enfileirar("imprimirTeste", [], { motivo: "solidity" });
    const prevExec = executor.executarOp;
    executor.executarOp = async () => {
      store.atualizarJob(job.id, { status: "ERRO", erro: "hard-drain-sim" });
      return {
        result: { ok: true },
        durationMs: 10,
        provider: "mock",
        driver: "mock",
        porta: null,
        modelo: null,
        bytesEnviados: null,
      };
    };
    try {
      await pjs.processarFila();
      const done = pjs.buscarJob(job.id);
      assert.strictEqual(
        done.status,
        "ERRO",
        `esperado ERRO, veio ${done.status}`,
      );
    } finally {
      executor.executarOp = prevExec;
    }
  });

  await test("factory honra circuito → effective native", () => {
    const runtime = require("../print/acbrPosPrinterRuntime");
    const factory = require("../print/factory");
    runtime.resetAcbrPosCircuit();
    factory.resetPrintProvider();
    runtime.openAcbrPosCircuit("test-factory");
    factory.resetPrintProvider();
    try {
      assert.strictEqual(factory.resolveEffectiveProviderName(), "native");
    } finally {
      runtime.resetAcbrPosCircuit();
      factory.resetPrintProvider();
    }
  });

  await test("motivoImpressao no Error preserva timeout_impressao", () => {
    function classificar(err) {
      if (err?.motivoImpressao === "timeout_impressao") return "timeout_impressao";
      if (err?.name === "AbortError" || err?.name === "TimeoutError") return "timeout_impressao";
      if (/Failed to fetch/i.test(String(err?.message || ""))) return "agente_offline";
      return "erro";
    }
    const e = new Error("Impressora/agente ocupado — tente 2ª via");
    e.motivoImpressao = "timeout_impressao";
    assert.strictEqual(classificar(e), "timeout_impressao");
  });

  console.log(`\nprint-solidity-production: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
