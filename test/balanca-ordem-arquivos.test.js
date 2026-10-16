"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ordenarArquivos } = require("../src/balanca/atomicWrite");

test("ordem MGV6: ITENSMGV → DEPTO → ARQSOK", () => {
  const entrada = [
    { nome: "ARQSOK.TXT" },
    { nome: "DEPTO.TXT" },
    { nome: "ITENSMGV.TXT" },
  ];
  const out = ordenarArquivos(entrada).map((a) => a.nome);
  assert.deepEqual(out, ["ITENSMGV.TXT", "DEPTO.TXT", "ARQSOK.TXT"]);
});
