#!/usr/bin/env node
/**
 * NF-e entrada — Distribuição DFe + Manifestação do Destinatário (ACBr)
 */
const assert = require("assert");
const acbr = require("../acbr");

const CHAVE =
  "35260611222333000181550010000000301025012345";
const CNPJ = "11222333000181";

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
  console.log("nfe-entrada-dfe.test.js\n");

  await test("resolverUfIbgeDestinatario — sigla SP", () => {
    assert.strictEqual(acbr.resolverUfIbgeDestinatario("SP", CHAVE), "35");
  });

  await test("resolverUfIbgeDestinatario — código numérico", () => {
    assert.strictEqual(acbr.resolverUfIbgeDestinatario("31", CHAVE), "31");
  });

  await test("montarIniManifestacaoCiencia — CNPJ, cOrgao 91, tpAmb, dhEvento BR", () => {
    const ini = acbr.montarIniManifestacaoCiencia(CHAVE, CNPJ);
    assert.ok(ini.includes("cOrgao=91"), "cOrgao deve ser 91 (Ambiente Nacional)");
    assert.ok(ini.includes(`CNPJ=${CNPJ}`), "CNPJ do destinatário obrigatório");
    assert.ok(ini.includes("tpEvento=210210"), "tpEvento ciência da operação");
    assert.ok(/tpAmb=[12]/.test(ini), "tpAmb conforme AMBIENTE_SEFAZ");
    assert.ok(/dhEvento=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/.test(ini), "dhEvento formato ACBr");
    assert.ok(!ini.includes("CNPJ=\n"), "CNPJ não pode estar vazio");
  });

  await test("montarIniManifestacaoCiencia rejeita CNPJ ausente", () => {
    assert.throws(
      () => acbr.montarIniManifestacaoCiencia(CHAVE, ""),
      /CNPJ do destinatário obrigatório/,
    );
  });

  await test("isCStatManifestacaoOk — 573 duplicidade", () => {
    assert.strictEqual(acbr.isCStatManifestacaoOk("573", ""), true);
    assert.strictEqual(acbr.isCStatManifestacaoOk("135", ""), true);
    assert.strictEqual(acbr.isCStatManifestacaoOk("204", ""), false);
  });

  await test("distribuicaoDFePorChave rejeita CNPJ ausente", async () => {
    await assert.rejects(
      () => acbr.distribuicaoDFePorChave(CHAVE, "", "SP"),
      /CNPJ do destinatário obrigatório/,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
