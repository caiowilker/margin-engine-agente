#!/usr/bin/env node
/**
 * Contrato path/pacote NFS-e Lib — sem carregar a DLL (Linux/CI).
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const nfseLib = require("../fiscal/nfse/nfseLib");

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

console.log("\nnfse-lib-path");

test("resolveNfseLibPath encontra ACBrNFSe64.dll em acbrlib/lib quando presente", () => {
  const dll = path.join(__dirname, "..", "acbrlib", "lib", "ACBrNFSe64.dll");
  if (!fs.existsSync(dll)) {
    console.log("  · skip (DLL ausente no workspace)");
    return;
  }
  const resolved = nfseLib.resolveNfseLibPath();
  assert.ok(resolved, "path esperado");
  assert.ok(resolved.endsWith("ACBrNFSe64.dll") || resolved.endsWith("libacbrnfse64.so"));
});

test("ACBR_NFSE_LIB_PATH explícito tem prioridade", () => {
  const dll = path.join(__dirname, "..", "acbrlib", "lib", "ACBrNFSe64.dll");
  if (!fs.existsSync(dll)) {
    console.log("  · skip (DLL ausente)");
    return;
  }
  const prev = process.env.ACBR_NFSE_LIB_PATH;
  process.env.ACBR_NFSE_LIB_PATH = dll;
  try {
    assert.strictEqual(nfseLib.resolveNfseLibPath(), path.resolve(dll));
  } finally {
    if (prev) process.env.ACBR_NFSE_LIB_PATH = prev;
    else delete process.env.ACBR_NFSE_LIB_PATH;
  }
});

test("canLoadNativeNfseLib é false fora do Windows", () => {
  if (process.platform === "win32") {
    console.log("  · skip (rodando no Windows)");
    return;
  }
  assert.strictEqual(nfseLib.canLoadNativeNfseLib(), false);
  assert.strictEqual(nfseLib.getNfseIntegrationMode(), "monitor");
});

test("getNfseLibInfo expõe pacote oficial", () => {
  const info = nfseLib.getNfseLibInfo();
  assert.strictEqual(info.package, "@projetoacbr/acbrlib-nfse-node");
  assert.strictEqual(info.provider, "acbr-lib-nfse");
  assert.ok(info.mode === "native" || info.mode === "monitor");
});

test("loadAcbrLibNfse carrega ACBrLibNFSeMT e NFSeModoEnvio", () => {
  const { ACBrLibNFSeMT, NFSeModoEnvio } = nfseLib.loadAcbrLibNfse();
  assert.strictEqual(typeof ACBrLibNFSeMT, "function");
  assert.strictEqual(NFSeModoEnvio.LOTE_SINCRONO, 2);
});

test("lib driver getDriverInfo inclui bloco nfse", () => {
  const prevDriver = process.env.ACBR_DRIVER;
  const prevParity = process.env.ACBR_LIB_ALLOW_PARITY;
  process.env.ACBR_DRIVER = "lib";
  process.env.ACBR_LIB_ALLOW_PARITY = "true";
  try {
    const factory = require("../fiscal/factory");
    factory.resetFiscalDriver();
    const lib = factory.createDriver("lib");
    const info = lib.getDriverInfo();
    assert.ok(info.nfse, "nfse no getDriverInfo");
    assert.strictEqual(info.nfse.package, "@projetoacbr/acbrlib-nfse-node");
  } finally {
    if (prevDriver) process.env.ACBR_DRIVER = prevDriver;
    else delete process.env.ACBR_DRIVER;
    if (prevParity) process.env.ACBR_LIB_ALLOW_PARITY = prevParity;
    else delete process.env.ACBR_LIB_ALLOW_PARITY;
    try {
      require("../fiscal/factory").resetFiscalDriver();
    } catch (_) {
      /* ignore */
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
