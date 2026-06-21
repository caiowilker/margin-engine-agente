const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toThermalText, toThermalDoc } = require("../thermalText");
const { inferirModeloDaChave } = require("../acbr");

test("toThermalText remove acentos e caracteres fora de ASCII", () => {
  assert.equal(toThermalText("São Paulo — Centro"), "Sao Paulo - Centro");
  assert.equal(toThermalText("Açougue & Cia"), "Acougue & Cia");
});

test("toThermalDoc preserva formatacao de CNPJ", () => {
  assert.equal(toThermalDoc("12.345.678/0001-90"), "12.345.678/0001-90");
  assert.equal(toThermalDoc("12\uFF0E345"), "12.345");
});

test("inferirModeloDaChave le modelo na posicao 21-22", () => {
  const chave55 =
    "31250612345678000190550010000000011000000001".padEnd(44, "0");
  const mod = chave55.substring(20, 22);
  assert.equal(mod, "55");
  assert.equal(inferirModeloDaChave(chave55), "55");
});
