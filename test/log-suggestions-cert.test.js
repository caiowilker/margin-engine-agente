/**
 * Sugestões de log: senha vs certificado expirado.
 */
const assert = require("assert");
const { test } = require("node:test");
const { sugerirParaErro } = require("../runtime/logSuggestions");
const { paraOperador } = require("../runtime/mensagensOperador");

test("senha errada não vira certificado expirado", () => {
  const s = sugerirParaErro("-10: PFXDataToCertContextWinApi: Senha informada está errada");
  assert.match(s.causa, /senha/i);
  assert.doesNotMatch(s.causa, /expirad/i);
});

test("expirado mantém causa de validade", () => {
  const s = sugerirParaErro("Data de Validade do Certificado já expirou: 22/07/2026");
  assert.match(s.causa, /expirad/i);
});

test("latência de impressão (E2E) não vira 'falha de cabo USB'", () => {
  const s = sugerirParaErro("[PrintJob] E2E >1s — regressão de latência");
  assert.doesNotMatch(s.causa, /comunicação com a impressora/i);
});

test("PKCS12 mac verify → senha", () => {
  const s = sugerirParaErro("PKCS12_parse:mac verify failure");
  assert.match(s.causa, /senha/i);
});

test("mensagem operador diferencia senha e expirado", () => {
  const senha = paraOperador({
    message: "Senha informada está errada",
  });
  assert.match(String(senha.problema || senha.causa || ""), /senha/i);

  const exp = paraOperador({
    message: "Data de Validade do Certificado já expirou: 22/07/2026",
  });
  assert.match(String(exp.problema || exp.causa || ""), /expir/i);
});
