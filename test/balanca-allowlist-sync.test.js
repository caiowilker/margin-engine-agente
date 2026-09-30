"use strict";

/**
 * Garante que a allowlist do agente espelha os nomes canônicos do backend.
 * Se adicionar arquivo em BalancaCargaArquivoAllowlist.java, atualize aqui na mesma PR.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { nomePermitido } = require("../src/balanca/allowlist");

/** Espelho uppercase dos nomes canônicos do backend (sem variantes de case). */
const BACKEND_CANONICOS = [
  "ITENSMGV.TXT",
  "PRECOMGV.TXT",
  "EXCLITEM.TXT",
  "ARQSOK.TXT",
  "CADTXT.TXT",
  "SETORTXT.TXT",
  "TXITENS.TXT",
  "RAMUZA_ORIGINAL.TXT",
  "PRODUTOS.TXT",
];

test("allowlist agente aceita todos os canônicos do backend", () => {
  for (const n of BACKEND_CANONICOS) {
    assert.equal(nomePermitido(n), true, `faltando no agente: ${n}`);
  }
});

test("allowlist rejeita path traversal e nomes estranhos", () => {
  assert.equal(nomePermitido("../x.TXT"), false);
  assert.equal(nomePermitido("evil.zip"), false);
  assert.equal(nomePermitido("_meta.json"), false);
});
