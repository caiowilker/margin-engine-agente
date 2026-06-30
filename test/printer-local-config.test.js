#!/usr/bin/env node
/**
 * Testes printerLocalConfig — npm run test:print
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "printer-cfg-"));
const iniPath = path.join(tmpRoot, "posprinter.ini");
const envPath = path.join(tmpRoot, ".env");

process.env.ACBR_POSPRINTER_INI = iniPath;
process.env.PRINTER_LOCAL_ENV_OVERRIDE = envPath;
process.env.PRINTER_PROVIDER = "acbr-posprinter";
process.env.PRINTER_FALLBACK = "native";

const cfg = require("../print/printerLocalConfig");

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

test("ler — defaults quando INI ausente", () => {
  const l = cfg.ler();
  assert.strictEqual(l.provider, "acbr-posprinter");
  assert.ok(l.iniPath);
});

test("salvar — persiste porta e modelo no INI", () => {
  const saved = cfg.salvar({
    porta: "COM3",
    modelo: "3",
    colunas: "42",
    encoding: "UTF8",
    cut: "partial",
  });
  assert.strictEqual(saved.porta, "COM3");
  assert.strictEqual(saved.modelo, "3");
  const raw = fs.readFileSync(iniPath, "utf8");
  assert.ok(raw.includes("Porta=COM3"));
  assert.ok(raw.includes("Modelo=3"));
});

test("salvar — inferir modelo a partir do nome da impressora", () => {
  const saved = cfg.salvar({
    nomeImpressora: "EPSON TM-T20 Receipt",
    modeloAuto: true,
  });
  assert.strictEqual(saved.modelo, "3");
});

test("sincronizarDeDeteccao — ignora sem impressora", () => {
  const before = cfg.ler().modelo;
  cfg.sincronizarDeDeteccao({});
  assert.strictEqual(cfg.ler().modelo, before);
});

console.log(`\nprinter-local-config: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
