#!/usr/bin/env node
/** Schema de env de impressão — clamp + SSOT */
const assert = require("assert");
const {
  applyPrintEnvSchema,
  PRINT_ENV_FIELDS,
  renderPrintEnvExampleBlock,
} = require("../config/printEnvSchema");

const orig = { ...process.env };

function restore() {
  for (const k of Object.keys(process.env)) {
    if (!(k in orig)) delete process.env[k];
  }
  Object.assign(process.env, orig);
}

function run() {
  restore();
  delete process.env.PRINT_JOB_TIMEOUT_FAST_MS;
  delete process.env.ACBR_POS_WORKER;
  delete process.env.PHYSICAL_USB_TOPOLOGY;

  const r1 = applyPrintEnvSchema(process.env);
  assert.strictEqual(process.env.PRINT_JOB_TIMEOUT_FAST_MS, "6500");
  assert.strictEqual(process.env.ACBR_POS_CALL_TIMEOUT_MS, "4500");
  assert.strictEqual(process.env.PRINT_ENVIANDO_STALE_MS, "25000");
  assert.strictEqual(process.env.ACBR_POS_WORKER, "true");
  assert.strictEqual(process.env.PHYSICAL_USB_TOPOLOGY, "separate");
  assert.strictEqual(process.env.PRINT_HARD_DRAIN_MS, "2000");
  assert.ok(r1.applied.PRINTER_RAW_TIMEOUT_MS === "4000");

  process.env.PRINT_JOB_TIMEOUT_FAST_MS = "99999";
  process.env.PHYSICAL_USB_TOPOLOGY = "weird";
  process.env.ACBR_POS_WORKER = "maybe";
  const r2 = applyPrintEnvSchema(process.env);
  assert.strictEqual(process.env.PRINT_JOB_TIMEOUT_FAST_MS, "6500");
  assert.strictEqual(process.env.PHYSICAL_USB_TOPOLOGY, "separate");
  // bool inválido → default canônico true
  assert.strictEqual(process.env.ACBR_POS_WORKER, "true");
  assert.ok(r2.clamped.length >= 2);

  process.env.ACBR_POS_WORKER = "false";
  applyPrintEnvSchema(process.env);
  assert.strictEqual(process.env.ACBR_POS_WORKER, "false");

  const block = renderPrintEnvExampleBlock();
  for (const f of PRINT_ENV_FIELDS) {
    assert.ok(block.includes(`${f.env}=${f.default}`), f.env);
  }

  restore();
  console.log("print-env-schema.test.js OK");
}

run();
