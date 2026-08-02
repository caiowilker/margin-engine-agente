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
  assert.strictEqual(saved.modelo, "1");
});

test("sincronizarDeDeteccao — ignora sem impressora", () => {
  const before = cfg.ler().modelo;
  cfg.sincronizarDeDeteccao({});
  assert.strictEqual(cfg.ler().modelo, before);
});

test("salvar — idempotente: mesma porta/modelo não reseta", () => {
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    tipo: "windows",
    nomeImpressora: "POSPrinter POS80",
  });
  const mtime1 = fs.statSync(iniPath).mtimeMs;
  const raw1 = fs.readFileSync(iniPath, "utf8");
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    tipo: "windows",
    nomeImpressora: "POSPrinter POS80",
  });
  const mtime2 = fs.statSync(iniPath).mtimeMs;
  const raw2 = fs.readFileSync(iniPath, "utf8");
  assert.strictEqual(raw1, raw2);
  assert.strictEqual(mtime1, mtime2);
});

test("sincronizarDeDeteccao — idempotente quando já sincronizado", () => {
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    tipo: "windows",
    nomeImpressora: "POSPrinter POS80",
  });
  const mtime1 = fs.statSync(iniPath).mtimeMs;
  cfg.sincronizarDeDeteccao({
    impressora: { nome: "POSPrinter POS80", metodo: "windows", porta: "USB001" },
  });
  assert.strictEqual(fs.statSync(iniPath).mtimeMs, mtime1);
});

test("salvar — rejeita TCP sem pontos", () => {
  assert.throws(
    () => cfg.salvar({ porta: "TCP:192168150:9100" }),
    /Porta inválida|PRINTER_PORTA_INVALIDA/,
  );
});

test("salvar — paperMm 80 persiste colunas e paperMm na leitura", () => {
  const saved = cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    paperMm: 80,
    tipo: "windows",
    nomeImpressora: "POSPrinter POS80",
  });
  assert.strictEqual(Number(saved.paperMm), 80);
  assert.ok(Number(saved.colunas) >= 40);
});

test("salvar — modelo 0 + POS80 vira 1", () => {
  const saved = cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "0",
    tipo: "windows",
  });
  assert.strictEqual(saved.modelo, "1");
});

test("sanitizar — remove TCP sem pontos e limpa PRINTER_HOST", () => {
  fs.writeFileSync(
    iniPath,
    `[PosPrinter]\nModelo=1\nPorta=TCP:192168150:9100\nColunasFonteNormal=48\nPaginaDeCodigo=2\nCortaPapel=1\n`,
    "utf8",
  );
  process.env.PRINTER_HOST = "192168150";
  process.env.PRINTER_PORTA = "TCP:192168150:9100";
  cfg.invalidateLerCache();
  const out = cfg.sanitizarConfigPersistida();
  assert.ok(!out.porta || out.porta === "", `porta deveria estar vazia, veio ${out.porta}`);
  assert.strictEqual(String(process.env.PRINTER_HOST || ""), "");
});

test("sanitizar — RAW válido zera host fantasma", () => {
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    tipo: "windows",
    nomeImpressora: "POSPrinter POS80",
  });
  process.env.PRINTER_HOST = "192168150";
  cfg.sanitizarConfigPersistida();
  assert.strictEqual(String(process.env.PRINTER_HOST || ""), "");
  assert.ok(/^RAW:/i.test(cfg.ler({ fresh: true }).porta));
});

test("salvar — drawer=false grava PRINTER_DRAWER (loja sem gaveta)", () => {
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    drawer: false,
  });
  assert.strictEqual(process.env.PRINTER_DRAWER, "false");
  assert.strictEqual(cfg.ler({ fresh: true }).drawer, false);
  cfg.salvar({
    porta: "RAW:POSPrinter POS80",
    modelo: "1",
    drawer: true,
  });
  assert.strictEqual(process.env.PRINTER_DRAWER, "true");
  assert.strictEqual(cfg.ler({ fresh: true }).drawer, true);
});

test("gerarIni — produção: LogNivel=0 + BytesCount + ControlePorta RAW=0", () => {
  const raw = cfg.gerarIniContent({
    modelo: "1",
    porta: "RAW:POSPrinter POS80",
    colunas: "48",
    pageCode: "2",
    cut: "partial",
  });
  assert.ok(/LogNivel=0/.test(raw), "log produção off");
  assert.ok(/ArqLog=/.test(raw));
  assert.ok(/BytesCount=512/.test(raw));
  assert.ok(/BytesInterval=10/.test(raw));
  assert.ok(/ControlePorta=0/.test(raw));
  assert.ok(/\[PosPrinter_Device\]/.test(raw));
});

console.log(`\nprinter-local-config: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
