#!/usr/bin/env node
/**
 * Testes — installer-diagnostic.js (sem serviço em execução).
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "data-installer-diag");
const appDir = path.resolve(__dirname, "..");

function rmDir(d) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

async function main() {
  console.log("installer-diagnostic.test.js\n");
  rmDir(ROOT);
  process.env.MARGIN_ENGINE_ROOT = ROOT;
  process.env.LOG_SILENT = "true";

  const { resetDirectoryManager } = require("../runtime/directoryManager");
  resetDirectoryManager();

  const { runDiagnostic, writeReports } = require("../scripts/installer-diagnostic");
  const report = await runDiagnostic();
  const { text } = writeReports(report, ROOT);

  assert.equal(report.product, "Margin Engine");
  assert.ok(report.version);
  assert.ok(text.includes("Margin Engine"));
  assert.ok(!text.match(/\bACBr\b/i), "texto não deve mencionar ACBr");
  assert.ok(!text.match(/\bDLL\b/i), "texto não deve mencionar DLL");

  console.log("  ✓ relatório gerado sem termos internos");
  console.log("  ✓ checks básicos executados");

  rmDir(ROOT);
  console.log("\nConcluído.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
