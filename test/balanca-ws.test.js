#!/usr/bin/env node
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "me-balanca-ws-"));
process.env.MARGIN_ENGINE_ROOT = tmpRoot;
process.env.BALANCA_VAULT_OVERRIDE = path.join(tmpRoot, ".balanca-vault");
process.env.BALANCA_CONFIG_OVERRIDE = path.join(tmpRoot, "balanca-carga.json");
process.env.LOG_SILENT = "true";

const { resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();

const { criarClienteWs, ERROS_COMUNS } = require("../src/balanca/wsClient");
const { enfileirarSerial, limparFilas } = require("../src/balanca/wsQueue");
const { processarLoteWs } = require("../src/balanca/wsRunner");
const balancaSecrets = require("../src/balanca/balancaSecrets");

after(() => {
  limparFilas();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mockFetchSequencial(respostas) {
  let i = 0;
  return async (url, opts) => {
    const step = respostas[i++] || { status: 500, body: { Msg: "sem mock" } };
    if (step.throwTimeout) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () =>
        typeof step.body === "string" ? step.body : JSON.stringify(step.body),
    };
  };
}

test("ERROS_COMUNS cobre -1..-5", () => {
  for (const c of ["-1", "-2", "-3", "-4", "-5"]) {
    assert.ok(ERROS_COMUNS[c]);
  }
});

test("GetToken sucesso + fluxo completo IMPORTADO", async () => {
  const fetchImpl = mockFetchSequencial([
    { status: 200, body: { Sucesso: true, Token: "tok-abc", ExpireAt: "2099-01-01" } },
    { status: 200, body: { Codigo: "42", Msg: "ok", Importado: true } },
    { status: 200, body: null },
    { status: 200, body: { Codigo: "", Msg: "", Importado: true } },
    { status: 200, body: { Codigo: "", Msg: "", Importado: true } },
  ]);
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl,
    timeoutMs: 5000,
  });
  const tok = await client.getToken("u", "s");
  assert.equal(tok.token, "tok-abc");
  const ini = await client.iniciaImportacao({
    loja: 1,
    palavraChave: "chave",
    quantidadeDeArquivos: 1,
  });
  assert.equal(String(ini.numeroDaImportacao), "42");
  const itens = await client.importaItem(42, [{ Codigo: "000001", Preco: 1.5 }]);
  assert.equal(itens.ok, true);
  const sc = await client.solicitaCargaNaBalanca(42, {
    OpcoesDeComunicacao: [{ OpcoesComunicacaoInt: 2, Simultaneidade: false, TipoDeDadoInt: 3 }],
  });
  assert.equal(sc.ok, true);
  const fin = await client.finalizaImportacao(42);
  assert.equal(fin.ok, true);
});

test("ImportaItem erro parcial no corpo (ERetornoImp)", async () => {
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl: mockFetchSequencial([
      {
        status: 200,
        body: [
          { Codigo: "000001", Msg: "ok", Importado: true },
          { Codigo: "000002", Msg: "falhou", Importado: false },
        ],
      },
    ]),
  });
  const r = await client.importaItem(1, []);
  assert.equal(r.ok, false);
  assert.equal(r.falhas.length, 1);
  assert.equal(r.falhas[0].Codigo, "000002");
});

test("erro -4 no corpo de IniciaImportacao", async () => {
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl: mockFetchSequencial([
      { status: 200, body: { Codigo: "-4", Msg: "nao autorizado", Importado: false } },
    ]),
  });
  await assert.rejects(
    () =>
      client.iniciaImportacao({
        loja: 1,
        palavraChave: "x",
        quantidadeDeArquivos: 1,
      }),
    /nao autorizado|autorizado|IniciaImportacao|numeroDaImportacao/i,
  );
});

test("token inválido", async () => {
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl: mockFetchSequencial([
      { status: 200, body: { Sucesso: false, Token: null } },
    ]),
  });
  await assert.rejects(() => client.getToken("u", "bad"), /Token inválido/);
});

test("timeout", async () => {
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl: mockFetchSequencial([{ throwTimeout: true }]),
    timeoutMs: 100,
  });
  await assert.rejects(() => client.obtemVersao(), /Timeout/);
});

test("contingência HTTP 503", async () => {
  const client = criarClienteWs({
    baseUrl: "http://mgv.local",
    fetchImpl: mockFetchSequencial([
      { status: 503, body: "servidor de Contingência" },
    ]),
  });
  await assert.rejects(() => client.obtemVersao(), /Contingência|conting/);
});

test("fila serial: nunca paralelo", async () => {
  const order = [];
  const p1 = enfileirarSerial("mgv-a", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 40));
    order.push("a-end");
    return 1;
  });
  const p2 = enfileirarSerial("mgv-a", async () => {
    order.push("b-start");
    order.push("b-end");
    return 2;
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("processarLoteWs sucesso via mock", async () => {
  balancaSecrets.salvarSync({
    usuario: "op",
    senha: "segredo",
    palavraChave: "chave10xx",
  });
  const fetchImpl = mockFetchSequencial([
    { status: 200, body: { Sucesso: true, Token: "t" } },
    { status: 200, body: { Codigo: "7", Msg: "ok", Importado: true } },
    { status: 200, body: null },
    { status: 200, body: { Codigo: "", Importado: true } },
    { status: 200, body: { Codigo: "", Importado: true } },
  ]);
  const r = await processarLoteWs(
    {
      loteId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      modoEntrega: "WS_MGV7",
      timeoutImportacaoSeg: 5,
      ws: {
        lojaCodigo: 1,
        itens: [
          {
            Codigo: "000001",
            Preco: 10.5,
            CodDepartamento: 1,
            TipoVendaInt: 0,
            DiasValidade: 0,
            Descritivo1aLinha: "TESTE",
          },
        ],
        precos: [],
      },
    },
    {
      modoSombra: false,
      wsBaseUrl: "http://mgv.test",
      wsLojaCodigo: 1,
      timeoutImportacaoSeg: 5,
    },
    { fetchImpl },
  );
  assert.equal(r.status, "IMPORTADO");
  assert.match(r.detalhe, /WS MGV7/);
});

test("cofre não expõe senha no resumo", () => {
  balancaSecrets.salvarSync({ usuario: "u", senha: "secret", palavraChave: "pk" });
  const r = balancaSecrets.resumoSeguro();
  assert.equal(r.temSenha, true);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});
