#!/usr/bin/env node
/**
 * Invariantes de produção — hot path térmico (POS80 / RAW:Windows).
 * Quebrar estes testes = risco de PDV travado no salão.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const CORE = path.join(__dirname, "../print/escpos/impressoraCore.js");
const PROVIDER = path.join(__dirname, "../print/drivers/acbrPosPrinterProvider.js");
const SCHEMA = path.join(__dirname, "../config/printEnvSchema.js");

test("schema — PRINT_FAST_NATIVE default raw (enum)", () => {
  const { getPrintEnvField, applyPrintEnvSchema } = require("../config/printEnvSchema");
  const field = getPrintEnvField("PRINT_FAST_NATIVE");
  assert.strictEqual(field.kind, "enum");
  assert.strictEqual(field.default, "raw");
  assert.ok(field.values.includes("raw"));
  assert.ok(field.values.includes("false"));

  const env = {};
  applyPrintEnvSchema(env);
  assert.strictEqual(env.PRINT_FAST_NATIVE, "raw");
});

test("preferNativeEscPos — RAW comercial native; fiscal ACBr", () => {
  const { preferNativeEscPos } = require("../print/drivers/acbrPosPrinterProvider");
  const runtime = require("../print/acbrPosPrinterRuntime");
  const prevFast = process.env.PRINT_FAST_NATIVE;
  const prevPorta = process.env.PRINTER_PORTA;
  delete process.env.PRINT_FAST_NATIVE;
  process.env.PRINTER_PORTA = "RAW:POSPrinter POS80";
  runtime.resetAcbrPosCircuit();
  try {
    assert.strictEqual(preferNativeEscPos({ naoFiscal: true }), true);
    assert.strictEqual(preferNativeEscPos({}), true);
    assert.strictEqual(
      preferNativeEscPos({ chaveNfe: "35" + "0".repeat(42), naoFiscal: false }),
      false,
    );
  } finally {
    if (prevFast === undefined) delete process.env.PRINT_FAST_NATIVE;
    else process.env.PRINT_FAST_NATIVE = prevFast;
    if (prevPorta === undefined) delete process.env.PRINTER_PORTA;
    else process.env.PRINTER_PORTA = prevPorta;
    runtime.resetAcbrPosCircuit();
  }
});

test("hot path — logo só rawBytes; sem Image.load/ler/sharp", () => {
  const src = fs.readFileSync(CORE, "utf8");
  const start = src.indexOf("async function imprimirLogoCupomEscpos");
  const end = src.indexOf("async function renderCupomConteudo", start);
  // Ignora comentários — só código executável importa no salão.
  const body = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(body.includes("rawBytes"));
  assert.ok(!/Image\.load/.test(body));
  assert.ok(!/\.ler\(\)/.test(body));
  assert.ok(!/prepararArquivoEscpos/.test(body));
  assert.ok(!/printer\.image\(/.test(body));
});

test("RAW cupom — proíbe Add-Type TypeDefinition", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.ok(src.includes("nao compilar no cupom"));
  const marker = src.indexOf("function buildRawPrintScriptContent");
  const end = src.indexOf("function ensureRawPrintScript", marker);
  const scriptBuilder = src.slice(marker, end);
  assert.ok(!scriptBuilder.includes("TypeDefinition"));
  assert.ok(scriptBuilder.includes("Add-Type -Path"));
});

test("MemoryDevice — chunks (sem concat por write)", () => {
  const src = fs.readFileSync(CORE, "utf8");
  const start = src.indexOf("class MemoryDevice");
  const end = src.indexOf("function gerarBuffer", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("_chunks"));
  assert.ok(body.includes("getBuffer"));
  assert.ok(!/write\(data[\s\S]*Buffer\.concat\(\[this\.buffer/.test(body));
});

test("cleanup RAW — unlink async", () => {
  const src = fs.readFileSync(CORE, "utf8");
  assert.ok(src.includes("fs.promises.unlink(tmpCfg)"));
  assert.ok(src.includes("fs.promises.unlink(tmpBin)"));
  const start = src.indexOf("async function enviarRawWindowsUnlocked");
  const end = src.indexOf("function listarImpressorasWindows", start);
  const body = src.slice(start, end > 0 ? end : start + 8000);
  assert.ok(!/unlinkSync\(tmp/.test(body));
});

test("RAW_HELPER_MISSING — retryable sem fallback ACBr", () => {
  const { classifyPrintError } = require("../print/printErrors");
  const err = new Error("RawPrinterHelper.dll ausente");
  err.code = "RAW_HELPER_MISSING";
  const cls = classifyPrintError(err);
  assert.strictEqual(cls.retryable, true);
  assert.strictEqual(cls.fallbackSuggested, false);
});

test("provider default — PRINT_FAST_NATIVE||raw no código", () => {
  const src = fs.readFileSync(PROVIDER, "utf8");
  assert.ok(src.includes('PRINT_FAST_NATIVE || "raw"'));
  const schema = fs.readFileSync(SCHEMA, "utf8");
  assert.ok(/env:\s*"PRINT_FAST_NATIVE"[\s\S]*default:\s*"raw"/.test(schema));
});

test("imprimirTeste — sempre native (nunca ACBr tags / PRINT_FAST_NATIVE)", () => {
  const src = fs.readFileSync(PROVIDER, "utf8");
  const start = src.indexOf("async function imprimirTeste");
  assert.ok(start >= 0);
  const end = src.indexOf("async function abrirGaveta", start);
  const body = src.slice(start, end);
  assert.ok(body.includes("native.imprimirTeste"));
  assert.ok(!/imprimirTags\(/.test(body), "teste não pode ir por ACBr tags");
  assert.ok(!/preferNativeEscPos/.test(body), "teste ignora PRINT_FAST_NATIVE");

  const exec = fs.readFileSync(
    path.join(__dirname, "../print/printExecutor.js"),
    "utf8",
  );
  assert.ok(
    /op === ["']imprimirTeste["']/.test(exec),
    "executor deve forçar native no teste",
  );
});

test("acbr provider — tags lazy (módulo ausente não derruba load)", () => {
  const src = fs.readFileSync(PROVIDER, "utf8");
  assert.ok(src.includes("function loadAcbrTags"));
  assert.ok(!/^\s*const vasilhameTags = require/m.test(src));
  assert.ok(!/^\s*const crediarioTags = require/m.test(src));
});

test("preprint ACBr — abre circuito sticky", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../print/printExecutor.js"),
    "utf8",
  );
  assert.ok(src.includes("fallback_after_preprint_timeout"));
  assert.ok(src.includes("openAcbrPosCircuit"));
  assert.ok(src.includes("preprint_timeout"));
});
