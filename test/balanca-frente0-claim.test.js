"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { processarLote } = require("../src/balanca/loteRunner");
const { resolverModoSombra, tipoEscritaDeNome, statusUiDeAck, STATUS_UI } = require("../src/balanca/tipoEscrita");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balanca-e2e-"));
}

function arquivoFake(nome, texto = "x") {
  const buf = Buffer.from(texto, "latin1");
  const crypto = require("crypto");
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

test("resolverModoSombra: lote > config local", () => {
  assert.equal(resolverModoSombra({ modoSombra: false }, { modoSombra: true }), false);
  assert.equal(resolverModoSombra({ modoSombra: true }, { modoSombra: false }), true);
  assert.equal(resolverModoSombra({}, { modoSombra: true }), true);
  assert.equal(resolverModoSombra({}, { modoSombra: false }), false);
});

test("statusUiDeAck unificado", () => {
  assert.equal(statusUiDeAck("IMPORTADO"), STATUS_UI.CONFIRMADO);
  assert.equal(statusUiDeAck("ENTREGUE"), STATUS_UI.AGUARDANDO_CONFIRMACAO);
  assert.equal(statusUiDeAck("ENTREGUE_SEM_CONFIRMACAO"), STATUS_UI.AGUARDANDO_CONFIRMACAO);
  assert.equal(statusUiDeAck("ERRO"), STATUS_UI.FALHOU);
});

test("claim modoSombra=false grava flat na pastaCarga (sem _margin_balanca_sombra)", async () => {
  const pasta = tmpDir();
  const cfg = {
    pastaCarga: pasta,
    encoding: "windows-1252",
    modoSombra: true, // config local errada — claim deve vencer
    evidenciaEstrategia: "NENHUMA",
    modoEntrega: "PASTA",
  };
  const lote = {
    loteId: "lote-flat-1",
    modoEntrega: "PASTA",
    modoSombra: false,
    usaIncremental: false,
    evidenciaEstrategia: "NENHUMA",
    arquivos: [arquivoFake("ITENSMGV.TXT", "ITEM1")],
  };
  const r = await processarLote(lote, cfg);
  assert.ok(["ENTREGUE", "ENTREGUE_SEM_CONFIRMACAO", "IMPORTADO"].includes(r.status), r.status + " " + r.detalhe);
  assert.ok(fs.existsSync(path.join(pasta, "ITENSMGV.TXT")));
  assert.equal(fs.existsSync(path.join(pasta, "_margin_balanca_sombra")), false);
});

test("claim modoSombra=true grava em pasta sombra com _meta.json", async () => {
  const pasta = tmpDir();
  const cfg = {
    pastaCarga: pasta,
    encoding: "windows-1252",
    modoSombra: false,
    modoEntrega: "PASTA",
  };
  const lote = {
    loteId: "lote-sombra-1",
    modoEntrega: "PASTA",
    modoSombra: true,
    arquivos: [arquivoFake("CADTXT.TXT", "CAD1")],
  };
  const r = await processarLote(lote, cfg);
  assert.equal(r.status, "ENTREGUE");
  const sombra = path.join(pasta, "_margin_balanca_sombra", "lote-sombra-1");
  assert.ok(fs.existsSync(path.join(sombra, "CADTXT.TXT")));
  assert.ok(fs.existsSync(path.join(sombra, "_meta.json")));
  assert.equal(fs.existsSync(path.join(pasta, "CADTXT.TXT")), false);
});
