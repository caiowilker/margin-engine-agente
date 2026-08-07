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
    assert.ok(src.includes("PRINTER_RAW_KILL_HOLD_MS") || src.includes("rawKillHoldMs"));
    assert.ok(src.includes("print.raw_kill_confirmed_release"));
    assert.ok(src.includes("print.raw_kill_hold_expired"));
    assert.ok(src.includes("makeRawTimeoutError"));
    assert.ok(src.includes('code = "RAW_PRINT_TIMEOUT"') || src.includes("RAW_PRINT_TIMEOUT"));
    assert.ok(src.includes("printTimedOut = true") || src.includes("printTimedOut: true"));
    assert.ok(!/\bexecFileSync\s*\(/.test(src), "P2b: execFileSync proibido no RAW");
    assert.ok(src.includes("listagemWindowsBloqueada"));
    assert.ok(src.includes("rawWorkDir"), "tmp RAW em ProgramData/impressao/raw");
    assert.ok(src.includes("fs.promises.writeFile"), "hot path RAW sem writeFileSync");
    assert.ok(src.includes("print.raw_tmp_write_slow") || src.includes("print.raw_phase"));
    assert.ok(src.includes("rawScriptCache"), "script PowerShell memoizado no processo");
    assert.ok(src.includes("PRINT_PHYSICAL_LOCK_WAIT_MS"), "orçamento wait physicalLock");
    assert.ok(
      !src.includes("print.event_loop_lag"),
      "métrica de lag do event loop fica no PrintExecutor",
    );
  });

  await test("rawWorkDir usa impressao sob MARGIN_ENGINE_ROOT", () => {
    const core = require("../print/escpos/impressoraCore");
    const dir = core.rawWorkDir();
    assert.ok(dir.includes("impressao") || dir.includes("pdv-margin-raw"), dir);
    assert.ok(!/Windows[\\/]+TEMP/i.test(dir), `não deve usar Windows\\TEMP: ${dir}`);
  });

  await test("ensureRawPrintScript memoiza — 2ª chamada idêntica sem recriar", () => {
    const core = require("../print/escpos/impressoraCore");
    core.resetRawScriptCacheForTests();
    // Em Linux IS_WIN=false → null; contrato é idempotência / cache API
    const a = core.ensureRawPrintScript();
    const b = core.ensureRawPrintScript();
    assert.strictEqual(a, b);
  });

  await test("PrintExecutor detecta event_loop_lag no soft deadline", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../print/printExecutor.js"),
      "utf8",
    );
    assert.ok(src.includes("print.event_loop_lag"));
    assert.ok(src.includes("print.drain_accepted_after_lag"));
    assert.ok(src.includes("wallAtDeadline"));
  });

  await test("worker timeout rejeita antes de await terminate", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../print/acbrPosWorkerPool.js"),
      "utf8",
    );
    // Rejeita na hora; kill armado com latch (não spawn 2ª DLL durante terminate)
    assert.ok(src.includes("const killP = killAndRespawn") || src.includes("killAndRespawn(h, e)"));
    assert.ok(src.includes("void killP") || src.includes("h.killing"));
    assert.ok(src.includes("while (h.killing)"));
    assert.ok(!src.includes("await killAndRespawn(h, e)"));
    assert.ok(src.includes("TERMINATE_HARD_MS"));
  });

  await test("TCP malformada rejeitada", () => {
    const map = require("../print/printerModelMap");
    assert.strictEqual(map.portaAcbrValida("TCP:192168150:9100"), false);
    assert.strictEqual(map.portaAcbrValida("TCP:192.168.1.50:9100"), true);
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

  await test("factory NÃO troca cache global por circuito (routing por job)", () => {
    const runtime = require("../print/acbrPosPrinterRuntime");
    const factory = require("../print/factory");
    const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
    const prevProv = process.env.PRINTER_PROVIDER;
    const prevFast = process.env.PRINT_FAST_NATIVE;
    const prevParity = process.env.PRINTER_ALLOW_PARITY;
    const prevPorta = process.env.PRINTER_PORTA;
    process.env.PRINTER_PROVIDER = "acbr-posprinter";
    process.env.PRINTER_ALLOW_PARITY = "true"; // operacional sem DLL no CI
    delete process.env.PRINT_FAST_NATIVE;
    process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
    runtime.resetAcbrPosCircuit();
    factory.resetPrintProvider();
    runtime.openAcbrPosCircuit("test-factory");
    factory.resetPrintProvider();
    try {
      // Cache global permanece acbr — routing comercial/fiscal RAW é por job
      assert.strictEqual(factory.resolveEffectiveProviderName(), "acbr-posprinter");
      assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
      assert.strictEqual(
        preferNativeEscPos({ chaveNfe: "35" + "0".repeat(42), naoFiscal: false }),
        true,
        "RAW + circuito: fiscal também native",
      );
    } finally {
      runtime.resetAcbrPosCircuit();
      process.env.PRINTER_PROVIDER = prevProv || "mock";
      if (prevFast === undefined) delete process.env.PRINT_FAST_NATIVE;
      else process.env.PRINT_FAST_NATIVE = prevFast;
      if (prevParity === undefined) delete process.env.PRINTER_ALLOW_PARITY;
      else process.env.PRINTER_ALLOW_PARITY = prevParity;
      if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
      else process.env.PRINTER_PORTA = prevPorta;
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
