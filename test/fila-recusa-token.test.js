/**
 * 401 do backend com corpo `{ code, erro }` (token expirado/revogado) vira mensagem legível de reativação.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mensagemRecusaToken } = require("../fila");

test("usa código e mensagem do corpo JSON", () => {
  const corpo = JSON.stringify({ code: "AGENTE_TOKEN_EXPIRADO", erro: "O acesso deste caixa expirou.", acao: "REATIVAR_AGENTE" });
  assert.equal(mensagemRecusaToken(401, corpo), "AGENTE_TOKEN_EXPIRADO: O acesso deste caixa expirou.");
});

test("backend antigo (corpo vazio ou texto) mantém formato HTTP", () => {
  assert.equal(mensagemRecusaToken(401, ""), "HTTP 401: ");
  assert.equal(mensagemRecusaToken(403, "Forbidden"), "HTTP 403: Forbidden");
  assert.equal(mensagemRecusaToken(401, JSON.stringify({ message: "x" })), `HTTP 401: {"message":"x"}`);
});
