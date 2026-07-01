const { test } = require("node:test");
const assert = require("node:assert/strict");
const dh = require("../fiscal/fiscalDhEmiIni");

test("converte ISO para formato ACBr INI", () => {
  const ini = `[Identificacao]
dhEmi=2026-06-30T23:48:44-03:00
dhSaiEnt=2026-06-22T14:53:03
`;
  const out = dh.prepararIniParaEmissao(ini);
  assert.match(out, /dhEmi=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
  assert.match(out, /dhSaiEnt=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(out, /T\d{2}:/);
});

test("corrige formato híbrido inválido", () => {
  const out = dh.normalizarDatasIni("dhEmi=2026/06/30T23:48:44\n");
  assert.match(out, /^dhEmi=30\/06\/2026 23:48:44$/m);
});

test("formatarDhEmiAcbrIni padrão BR", () => {
  const d = new Date(2026, 5, 30, 23, 48, 44);
  assert.equal(dh.formatarDhEmiAcbrIni(d), "30/06/2026 23:48:44");
});
