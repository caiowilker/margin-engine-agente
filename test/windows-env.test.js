/**
 * Testes — resolução de pastas Windows sem caminhos fixos.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  sanitizePathForDisplay,
  resolveProgramDataRoot,
  getKnownFoldersDiagnostics,
} = require("../runtime/windowsEnv");

console.log("windows-env.test.js\n");

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

test("resolveProgramDataRoot respeita MARGIN_ENGINE_ROOT", () => {
  const prev = process.env.MARGIN_ENGINE_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "margin-we-"));
  process.env.MARGIN_ENGINE_ROOT = tmp;
  const { root } = resolveProgramDataRoot();
  assert.ok(root);
  assert.equal(root, path.normalize(tmp));
  if (prev) process.env.MARGIN_ENGINE_ROOT = prev;
  else delete process.env.MARGIN_ENGINE_ROOT;
});

test("sanitizePathForDisplay aceita caminhos arbitrários", () => {
  const shown = sanitizePathForDisplay(path.join("/tmp", "MarginEngine", "Logs"));
  assert.ok(typeof shown === "string");
  assert.ok(shown.length > 0);
});

test("getKnownFoldersDiagnostics retorna objeto", () => {
  const d = getKnownFoldersDiagnostics();
  assert.ok(typeof d === "object");
  assert.ok("Temp" in d);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
