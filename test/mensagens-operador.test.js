const test = require("node:test");
const assert = require("node:assert/strict");

const mo = require("../runtime/mensagensOperador");

test("respostaErroOperador não expõe termos técnicos", () => {
  const r = mo.respostaErroOperador(new Error("ACBr DLL crash C:\\ProgramData\\x.ini"));
  assert.ok(r.problema);
  assert.ok(r.causa);
  assert.ok(r.comoResolver);
  assert.ok(r.erro && r.erro.length > 10);
  assert.doesNotMatch(JSON.stringify(r), /ACBr|DLL|ProgramData|\.ini/i);
});

test("nomeDriverProfissional sem ACBrLib", () => {
  assert.equal(mo.nomeDriverProfissional({ mode: "native", provider: "lib" }), "Emissor integrado");
  assert.equal(mo.nomeDriverProfissional({ mode: "parity" }), "Modo alternativo");
});

test("sanitizarErroFila", () => {
  const s = mo.sanitizarErroFila("NFE_Enviar timeout após 90000ms — ACBrLib");
  assert.doesNotMatch(s, /ACBr|90000/i);
});
