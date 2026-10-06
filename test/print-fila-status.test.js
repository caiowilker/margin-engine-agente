#!/usr/bin/env node
/**
 * fila=true é ENFILEIRADO, nunca IMPRESSO: o front/back só podem marcar impresso com 200 sem fila.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { test } = require("node:test");

const {
  STATUS_ENTREGA,
  corpoEnfileirado,
  corpoImpresso,
  responderImpressao,
} = require("../print/printHttpResposta");

function resFake() {
  return {
    code: 200,
    body: null,
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

test("resultado assíncrono responde 202 ENFILEIRADO, impresso=false", () => {
  const res = resFake();
  responderImpressao(res, { async: true, jobId: "j1" }, { extraFila: { deduplicado: false } });
  assert.strictEqual(res.code, 202);
  assert.strictEqual(res.body.fila, true);
  assert.strictEqual(res.body.status, STATUS_ENTREGA.ENFILEIRADO);
  assert.strictEqual(res.body.impresso, false);
  assert.strictEqual(res.body.jobId, "j1");
});

test("queued (fila de retry) também é ENFILEIRADO", () => {
  const body = corpoEnfileirado({ queued: true, jobId: "j2", message: "na fila" });
  assert.strictEqual(body.status, "ENFILEIRADO");
  assert.strictEqual(body.mensagem, "na fila");
});

test("execução síncrona responde 200 IMPRESSO e extras não sobrescrevem o status", () => {
  const res = resFake();
  responderImpressao(res, { jobId: "j3" }, { extraImpresso: { jobId: "j3", status: "PENDENTE", fila: true } });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.status, STATUS_ENTREGA.IMPRESSO);
  assert.strictEqual(res.body.fila, false);
  assert.strictEqual(res.body.impresso, true);
  assert.deepStrictEqual(corpoImpresso().status, "IMPRESSO");
});

test("index.js: toda resposta com fila=true declara status ENFILEIRADO", () => {
  const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const linhas = src.split("\n");
  let total = 0;
  linhas.forEach((linha, i) => {
    if (/^\s*fila: true,/.test(linha)) {
      total++;
      assert.match(linhas[i + 1], /status: "ENFILEIRADO"/, `linha ${i + 2} sem status ENFILEIRADO`);
    }
  });
  assert.ok(total > 0);
});
