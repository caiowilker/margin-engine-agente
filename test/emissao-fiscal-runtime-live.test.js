#!/usr/bin/env node
/**
 * Regressão: EMISSAO_FISCAL vivo no driver Lib/Monitor após setRuntimeEmissaoFiscal.
 * Object.assign({}, acbr) congelava o boolean no boot — emissão falhava com
 * "EMISSAO_FISCAL desabilitada" mesmo após PUT /config/fiscal.
 */
const assert = require("assert");

process.env.ACBR_DRIVER = "monitor";
process.env.EMISSAO_FISCAL = "false";
process.env.ACBR_LIB_ALLOW_PARITY = "true";

const acbr = require("../acbr");
const factory = require("../fiscal/factory");
const { wrapAcbrExports } = require("../fiscal/wrapAcbrExports");
const { writeFileIfChanged } = require("../fiscal/drivers/acbrLibRuntime");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

factory.resetFiscalDriver();
acbr.setRuntimeEmissaoFiscal(null);

test("Object.assign congela EMISSAO_FISCAL (documenta o bug)", () => {
  acbr.setRuntimeEmissaoFiscal(false);
  const frozen = Object.assign({}, acbr);
  acbr.setRuntimeEmissaoFiscal(true);
  assert.strictEqual(acbr.EMISSAO_FISCAL, true);
  assert.strictEqual(frozen.EMISSAO_FISCAL, false, "Object.assign snapshotou false");
});

test("wrapAcbrExports preserva getter vivo", () => {
  acbr.setRuntimeEmissaoFiscal(false);
  const wrapped = wrapAcbrExports({ marcador: true });
  assert.strictEqual(wrapped.EMISSAO_FISCAL, false);
  acbr.setRuntimeEmissaoFiscal(true);
  assert.strictEqual(wrapped.EMISSAO_FISCAL, true);
  assert.strictEqual(wrapped.marcador, true);
  assert.strictEqual(typeof wrapped.emitirNfce, "function");
});

test("driver monitor reflete setRuntimeEmissaoFiscal", () => {
  process.env.ACBR_DRIVER = "monitor";
  factory.resetFiscalDriver();
  const monitor = factory.createDriver("monitor");
  acbr.setRuntimeEmissaoFiscal(false);
  assert.strictEqual(monitor.EMISSAO_FISCAL, false);
  acbr.setRuntimeEmissaoFiscal(true);
  assert.strictEqual(monitor.EMISSAO_FISCAL, true);
});

test("driver lib reflete setRuntimeEmissaoFiscal", () => {
  process.env.ACBR_DRIVER = "lib";
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  factory.resetFiscalDriver();
  const lib = factory.createDriver("lib");
  acbr.setRuntimeEmissaoFiscal(false);
  assert.strictEqual(lib.EMISSAO_FISCAL, false);
  acbr.setRuntimeEmissaoFiscal(true);
  assert.strictEqual(lib.EMISSAO_FISCAL, true);
});

test("fiscalDriver proxy reflete runtime após toggle", () => {
  process.env.ACBR_DRIVER = "lib";
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  factory.resetFiscalDriver();
  // Requer reload do proxy target — factory cache
  const fiscalDriver = require("../fiscalDriver");
  fiscalDriver.resetFiscalDriver();
  acbr.setRuntimeEmissaoFiscal(false);
  assert.strictEqual(fiscalDriver.EMISSAO_FISCAL, false);
  acbr.setRuntimeEmissaoFiscal(true);
  assert.strictEqual(fiscalDriver.EMISSAO_FISCAL, true);
});

test("writeFileIfChanged não altera mtime se conteúdo igual", () => {
  const tmp = path.join(os.tmpdir(), `me-ini-${Date.now()}.ini`);
  fs.writeFileSync(tmp, "a=1\n", "utf8");
  const m1 = fs.statSync(tmp).mtimeMs;
  const changed1 = writeFileIfChanged(tmp, "a=1\n");
  assert.strictEqual(changed1, false);
  const m2 = fs.statSync(tmp).mtimeMs;
  assert.strictEqual(m2, m1);
  const changed2 = writeFileIfChanged(tmp, "a=2\n");
  assert.strictEqual(changed2, true);
  assert.strictEqual(fs.readFileSync(tmp, "utf8"), "a=2\n");
  fs.unlinkSync(tmp);
});

test("fingerprint estável mesmo se ACBr regravar conteúdo do INI", () => {
  const { fingerprintRuntime } = require("../fiscal/drivers/acbrLibSession");
  const tmp = path.join(os.tmpdir(), `me-fp-${Date.now()}.ini`);
  fs.writeFileSync(tmp, "Ambiente=1\n", "utf8");
  const runtime = {
    libPath: "/x/lib.dll",
    iniConfig: tmp,
    tpAmb: "2",
    ambienteLib: "1",
    ambienteSefaz: "homologacao",
    certRel: "c.pfx",
    idCsc: "1",
    senha: "s",
    csc: "t",
  };
  const fp1 = fingerprintRuntime(runtime);
  fs.writeFileSync(tmp, "Ambiente=1\nLogPath=C:\\\\temp\\\\x\n", "utf8");
  const fp2 = fingerprintRuntime(runtime);
  assert.strictEqual(
    fp1,
    fp2,
    "conteúdo do INI não deve invalidar sessão (Lib grava em runtime)",
  );
  runtime.tpAmb = "1";
  assert.notStrictEqual(
    fp1,
    fingerprintRuntime(runtime),
    "mudança de ambiente deve invalidar fingerprint",
  );
  fs.unlinkSync(tmp);
});

test("fingerprint de sessão usa path estável (não mtime)", () => {
  const { fingerprintRuntime } = require("../fiscal/drivers/acbrLibSession");
  const tmp = path.join(os.tmpdir(), `me-fp2-${Date.now()}.ini`);
  fs.writeFileSync(tmp, "Ambiente=1\n", "utf8");
  const runtime = {
    libPath: "/x/ACBrNFe64.dll",
    iniConfig: tmp,
    tpAmb: "2",
    ambienteLib: "1",
    ambienteSefaz: "homologacao",
    certRel: "c.pfx",
    idCsc: "1",
    senha: "s",
    csc: "t",
  };
  const fp1 = fingerprintRuntime(runtime);
  const t0 = Date.now();
  while (Date.now() - t0 < 20) {
    /* mtime distinto */
  }
  fs.writeFileSync(tmp, "Ambiente=1\n", "utf8");
  const fp2 = fingerprintRuntime(runtime);
  assert.strictEqual(fp1, fp2, "mesmo SSOT → mesmo fingerprint");
  assert.strictEqual(writeFileIfChanged(tmp, "Ambiente=1\n"), false);
  fs.unlinkSync(tmp);
});

test("copyFileIfNeeded não regrava arquivo idêntico", () => {
  const { copyFileIfNeeded } = require("../fiscal/drivers/acbrLibRuntime");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-sync-"));
  const src = path.join(dir, "a.dll");
  const dest = path.join(dir, "b.dll");
  fs.writeFileSync(src, "DLLDATA");
  assert.strictEqual(copyFileIfNeeded(src, dest), true, "primeira cópia");
  assert.strictEqual(copyFileIfNeeded(src, dest), false, "segunda cópia deve skip");
  fs.writeFileSync(src, "DLLDATA!");
  assert.strictEqual(copyFileIfNeeded(src, dest), true, "size diferente → copia");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isKoffiDeadHandleError e recentlyHadKoffiDead", async () => {
  const session = require("../fiscal/drivers/acbrLibSession");
  assert.strictEqual(
    session.isKoffiDeadHandleError(
      new Error("Unexpected External value, expected void **"),
    ),
    true,
  );
  assert.strictEqual(
    session.isKoffiDeadHandleError(new Error("SEFAZ timeout")),
    false,
  );
  await session.invalidateNativeSession("koffi_dead");
  assert.strictEqual(session.recentlyHadKoffiDead(60_000), true);
});

test("slots NFe e NFS-e são separados no fingerprint", () => {
  const session = require("../fiscal/drivers/acbrLibSession");
  assert.strictEqual(session.resolveSlotKey({ libPath: "C:\\x\\ACBrNFe64.dll" }), "nfe");
  assert.strictEqual(session.resolveSlotKey({ libPath: "C:\\x\\ACBrNFSe64.dll" }), "nfse");
  const fpNfe = session.fingerprintRuntime({
    libPath: "C:/a/ACBrNFe64.dll",
    iniConfig: null,
    tpAmb: "2",
  });
  const fpNfse = session.fingerprintRuntime({
    libPath: "C:/a/ACBrNFSe64.dll",
    iniConfig: null,
    tpAmb: "2",
  });
  assert.notStrictEqual(fpNfe, fpNfse);
});

acbr.setRuntimeEmissaoFiscal(null);
process.env.ACBR_DRIVER = "monitor";
factory.resetFiscalDriver();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
