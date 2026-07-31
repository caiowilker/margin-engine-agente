#!/usr/bin/env node
/**
 * Solidez: Windows não usa FFI PosPrinter no main após morte do worker.
 */
const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acbr-inprocess-"));
process.env.ACBR_POS_CIRCUIT_FILE = path.join(tmp, "circuit.json");
process.env.LOG_SILENT = "true";
process.env.ACBR_POS_WORKER = "true";
delete process.env.ACBR_POS_ALLOW_INPROCESS;

const runtime = require("../print/acbrPosPrinterRuntime");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}:`, e.message);
    throw e;
  }
}

console.log("acbr-inprocess-guard");

test("allowInProcess — worker=false libera", () => {
  process.env.ACBR_POS_WORKER = "false";
  assert.strictEqual(runtime.allowInProcessAcbrFfi(), true);
  process.env.ACBR_POS_WORKER = "true";
});

test("allowInProcess — ALLOW_INPROCESS=true libera", () => {
  process.env.ACBR_POS_ALLOW_INPROCESS = "true";
  assert.strictEqual(runtime.allowInProcessAcbrFfi(), true);
  delete process.env.ACBR_POS_ALLOW_INPROCESS;
});

test("allowInProcess — worker on bloqueia (solidez)", () => {
  process.env.ACBR_POS_WORKER = "true";
  delete process.env.ACBR_POS_ALLOW_INPROCESS;
  assert.strictEqual(runtime.allowInProcessAcbrFfi(), false);
});

test("classify — INPROCESS_BLOCKED sugere native", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const c = classifyPrintError({
    code: "ACBR_POS_INPROCESS_BLOCKED",
    message: "bloqueado",
    fallbackNative: true,
  });
  assert.strictEqual(c.fallbackSuggested, true);
  assert.strictEqual(c.retryable, false);
});

test("circuito TTL default 0 no schema", () => {
  const { getPrintEnvField } = require("../config/printEnvSchema");
  const ttl = getPrintEnvField("ACBR_POS_CIRCUIT_TTL_MS");
  assert.ok(ttl);
  assert.strictEqual(ttl.default, 0);
});

console.log("acbr-inprocess-guard OK");
