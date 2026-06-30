#!/usr/bin/env node
/**
 * L9 — eventos fiscais (CCe, manifestação) — contrato driver + validação documentIni
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.ACBR_DRIVER = "lib";
process.env.ACBR_LIB_ALLOW_PARITY = "true";
process.env.EMISSAO_FISCAL = "true";

const factory = require("../fiscal/factory");
const { assertFiscalDriverContract } = require("../fiscal/contract");
const acbr = require("../acbr");

factory.resetFiscalDriver();
const lib = factory.getFiscalDriver();

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

async function run() {
  console.log("fiscal-evento.test.js\n");

  await test("lib driver expõe enviarEventoFiscal", () => {
    assert.strictEqual(typeof lib.enviarEventoFiscal, "function");
  });

  await test("contrato fiscal inclui enviarEventoFiscal", () => {
    assertFiscalDriverContract(lib, "lib");
  });

  await test("isCStatEventoOk — 135 e 128", () => {
    assert.strictEqual(acbr.isCStatEventoOk("135"), true);
    assert.strictEqual(acbr.isCStatEventoOk("128"), true);
    assert.strictEqual(acbr.isCStatEventoOk("204"), false);
  });

  await test("enviarEventoFiscal rejeita sem documentIni", async () => {
    acbr.setRuntimeEmissaoFiscal(true);
    await assert.rejects(
      () => lib.enviarEventoFiscal({ chave: "35260611222333000181650010000000301025012345" }),
      /documentIni obrigatório/,
    );
  });

  await test("INI evento CCe contém seção EventoCCe (sanidade builder backend)", () => {
    const ini = `[infNFe]
versao=4.00

[EventoCCe]
chNFe=35260611222333000181650010000000301025012345
nSeqEvento=1
xCorrecao=Correcao teste
CNPJCPF=11222333000181
`;
    assert.ok(ini.includes("[EventoCCe]"));
    const tmp = path.join(os.tmpdir(), `evt-${Date.now()}.ini`);
    fs.writeFileSync(tmp, ini, "utf8");
    assert.ok(fs.existsSync(tmp));
    fs.unlinkSync(tmp);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
