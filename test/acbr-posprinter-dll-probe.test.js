#!/usr/bin/env node
/**
 * Probe da DLL ACBrPosPrinter — espelha a prova da ACBrNFe (artefato + exports).
 * Não toca no fiscal. No Linux valida PE/exports; no Windows o script FFI completo.
 */
const assert = require("assert");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const PROBE = path.join(ROOT, "scripts", "probe-acbr-posprinter-native.js");
const DLL = path.join(ROOT, "posprinter", "lib", "ACBrPosPrinter64.dll");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("acbr-posprinter-dll-probe.test.js\n");

test("DLL bundled existe (ACBrPosPrinter64.dll)", () => {
  assert.ok(fs.existsSync(DLL), `ausente: ${DLL}`);
  assert.ok(fs.statSync(DLL).size > 100_000);
});

test("probe script — PE x64 + exports POS_* obrigatórios", () => {
  const r = spawnSync(process.execPath, [PROBE, "--cycles=1"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const jsonStart = (r.stdout || "").indexOf("{");
  assert.ok(jsonStart >= 0, "stdout sem JSON");
  const report = JSON.parse(r.stdout.slice(jsonStart));
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.sourceArtifact.peMachine, "x64");
  assert.ok(report.sourceArtifact.sha256.length === 64);
  assert.ok(report.exports.total >= 20, `exports POS_=${report.exports.total}`);
  assert.deepStrictEqual(report.exports.missingRequired, []);
  if (process.platform === "win32") {
    assert.strictEqual(report.ffi.ran, true);
    assert.ok(report.results?.length >= 1);
    assert.ok(report.results[0].initialized);
    assert.ok(report.results[0].finalized);
  } else {
    assert.ok(report.ffi.skipped);
  }
});

test("check-posprinter-deps — side DLLs no bundle", () => {
  const { checkPosprinterDeps } = require("../scripts/check-posprinter-deps");
  const report = checkPosprinterDeps();
  assert.ok(
    report.present.includes("ACBrPosPrinter64.dll"),
    JSON.stringify(report),
  );
  assert.strictEqual(report.ok, true, `missing=${JSON.stringify(report.missing)}`);
});

console.log(`\nacbr-posprinter-dll-probe: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
