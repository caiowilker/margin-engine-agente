#!/usr/bin/env node
/**
 * Circuito ACBr PosPrinter — persistência em disco + classificação de erros.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acbr-circuit-"));
const circuitFile = path.join(tmpRoot, "acbr-pos-circuit.json");
process.env.ACBR_POS_CIRCUIT_FILE = circuitFile;
process.env.PRINT_ACBR_CIRCUIT = "true";

// Isola módulo (cache) — path de circuito via env
delete require.cache[require.resolve("../print/acbrPosPrinterRuntime")];
const runtime = require("../print/acbrPosPrinterRuntime");
const { classifyPrintError } = require("../print/printErrors");

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

test("circuito inicia fechado", () => {
  runtime.resetAcbrPosCircuit();
  assert.strictEqual(runtime.isAcbrPosCircuitOpen(), false);
});

test("openAcbrPosCircuit persiste em disco", () => {
  runtime.resetAcbrPosCircuit();
  assert.strictEqual(runtime.openAcbrPosCircuit("POS_Ativar (-10)"), true);
  assert.strictEqual(runtime.isAcbrPosCircuitOpen(), true);
  assert.ok(fs.existsSync(circuitFile));
  const raw = JSON.parse(fs.readFileSync(circuitFile, "utf8"));
  assert.strictEqual(raw.open, true);
  assert.ok(String(raw.reason).includes("-10"));
});

test("reload do disco restaura circuito aberto", () => {
  runtime.resetAcbrPosCircuit();
  fs.writeFileSync(
    circuitFile,
    JSON.stringify({ open: true, reason: "persisted-test", openedAt: 1 }),
    "utf8",
  );
  runtime.__reloadCircuitFromDiskForTests();
  assert.strictEqual(runtime.isAcbrPosCircuitOpen(), true);
  assert.strictEqual(runtime.getAcbrPosCircuit().reason, "persisted-test");
});

test("reset remove arquivo do disco", () => {
  runtime.openAcbrPosCircuit("x");
  runtime.resetAcbrPosCircuit();
  assert.strictEqual(runtime.isAcbrPosCircuitOpen(), false);
  assert.strictEqual(fs.existsSync(circuitFile), false);
});

test("shouldOpenCircuitFromError — timeout e hard drain", () => {
  assert.strictEqual(
    runtime.shouldOpenCircuitFromError({ code: "PRINT_HARD_DRAIN", message: "Timeout" }),
    true,
  );
  assert.strictEqual(
    runtime.shouldOpenCircuitFromError({ code: "ACBR_POS_TIMEOUT" }),
    true,
  );
  assert.strictEqual(
    runtime.shouldOpenCircuitFromError({ code: "ACBR_POS_WORKER_KILLED" }),
    true,
  );
  assert.strictEqual(
    runtime.shouldOpenCircuitFromError({ code: "PRINTER_NOT_THERMAL" }),
    false,
  );
});

test("classifyPrintError — -10 não é retryable", () => {
  const cls = classifyPrintError({ acbrRet: -10, message: "POS_Ativar (-10)" });
  assert.strictEqual(cls.retryable, false);
  assert.strictEqual(cls.fallbackSuggested, true);
});

test("PRINT_ACBR_CIRCUIT=false desliga circuito mesmo aberto", () => {
  runtime.openAcbrPosCircuit("test");
  process.env.PRINT_ACBR_CIRCUIT = "false";
  assert.strictEqual(runtime.isAcbrPosCircuitOpen(), false);
  process.env.PRINT_ACBR_CIRCUIT = "true";
  runtime.resetAcbrPosCircuit();
});

console.log(`\nacbr-pos-circuit: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
