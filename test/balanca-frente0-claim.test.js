"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { processarLote } = require("../src/balanca/loteRunner");
const { tipoEscritaDeNome, statusUiDeAck, STATUS_UI } = require("../src/balanca/tipoEscrita");
const { iniciarSimuladorMgv } = require("../src/balanca/mgvSimulator");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balanca-e2e-"));
}

function arquivoFake(nome, texto = "x") {
  const buf = Buffer.from(texto, "latin1");
  return {
    nome,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    tamanho: buf.length,
    conteudoBase64: buf.toString("base64"),
    tipoEscrita: tipoEscritaDeNome(nome),
  };
}

test("tipoEscrita: snapshot vs incremental", () => {
  assert.equal(tipoEscritaDeNome("ITENSMGV.TXT"), "SNAPSHOT");
  assert.equal(tipoEscritaDeNome("CADTXT.TXT"), "SNAPSHOT");
  assert.equal(tipoEscritaDeNome("PRECOMGV.TXT"), "INCREMENTAL");
  assert.equal(tipoEscritaDeNome("EXCLITEM.TXT"), "INCREMENTAL");
});

test("statusUiDeAck unificado", () => {
  assert.equal(statusUiDeAck("IMPORTADO"), STATUS_UI.CONFIRMADO);
  assert.equal(statusUiDeAck("ENTREGUE"), STATUS_UI.AGUARDANDO_CONFIRMACAO);
  assert.equal(statusUiDeAck("ENTREGUE_SEM_CONFIRMACAO"), STATUS_UI.AGUARDANDO_CONFIRMACAO);
  assert.equal(statusUiDeAck("ERRO"), STATUS_UI.FALHOU);
  assert.equal(statusUiDeAck("DIAGNOSTICO_OK"), STATUS_UI.FALHOU);
});

test("claim grava ITENSMGV+DEPTO+ARQSOK flat na pastaCarga → IMPORTADO após .BAK", async () => {
  const pasta = tmpDir();
  const sim = iniciarSimuladorMgv(pasta, { delayMs: 60, modo: "ok" });
  const cfg = {
    pastaCarga: pasta,
    encoding: "windows-1252",
    timeoutImportacaoSeg: 5,
    intervaloPollingBakMs: 40,
    evidenciaEstrategia: "ARQUIVO_RENOMEADO_BAK",
    modoEntrega: "PASTA",
  };
  const lote = {
    loteId: "lote-prod-1",
    modoEntrega: "PASTA",
    usaIncremental: false,
    arquivos: [
      arquivoFake("ITENSMGV.TXT", "ITEM1"),
      arquivoFake("DEPTO.TXT", "DEPT1"),
      arquivoFake("ARQSOK.TXT", ""),
    ],
  };
  let entregue = false;
  const r = await processarLote(lote, cfg, {
    onEscrito: async () => {
      entregue = true;
    },
  });
  sim.stop();
  assert.equal(entregue, true);
  assert.equal(r.status, "IMPORTADO", r.detalhe);
  assert.ok(fs.existsSync(path.join(pasta, "ITENSMGV.TXT.BAK")) || !fs.existsSync(path.join(pasta, "ITENSMGV.TXT")));
  assert.equal(fs.existsSync(path.join(pasta, "_margin_balanca_manual")), false);
});
