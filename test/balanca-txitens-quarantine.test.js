"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  quarentenarTxitensResidual,
  quarentenarItensMgvResidual,
  entregarPastaMonitorada,
} = require("../src/balanca/entrega");

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "balanca-txitens-"));
});

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("quarentenarTxitensResidual move TXITENS residual", () => {
  fs.writeFileSync(path.join(tmp, "TXITENS.TXT"), "CLASSIC");
  quarentenarTxitensResidual(tmp);
  assert.equal(fs.existsSync(path.join(tmp, "TXITENS.TXT")), false);
  const orphan = path.join(tmp, "_margin_orphan");
  assert.ok(fs.existsSync(orphan));
  const moved = fs.readdirSync(orphan).filter((n) => n.includes("TXITENS"));
  assert.ok(moved.length >= 1);
});

test("quarentenarItensMgvResidual move ITENSMGV/DEPTO/ARQSOK", () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "balanca-classic-"));
  try {
    fs.writeFileSync(path.join(pasta, "ITENSMGV.TXT"), "MGV6");
    fs.writeFileSync(path.join(pasta, "DEPTO.TXT"), "D");
    fs.writeFileSync(path.join(pasta, "ARQSOK.TXT"), "");
    quarentenarItensMgvResidual(pasta);
    assert.equal(fs.existsSync(path.join(pasta, "ITENSMGV.TXT")), false);
    assert.equal(fs.existsSync(path.join(pasta, "DEPTO.TXT")), false);
    assert.equal(fs.existsSync(path.join(pasta, "ARQSOK.TXT")), false);
    const orphan = fs.readdirSync(path.join(pasta, "_margin_orphan"));
    assert.ok(orphan.some((n) => /ITENSMGV/i.test(n)));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test("entrega TXITENS quarentena ITENSMGV residual", async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "balanca-tx-entrega-"));
  try {
    fs.writeFileSync(path.join(pasta, "ITENSMGV.TXT"), "residual-mgv6");
    const body = Buffer.from("X".repeat(320));
    const b64 = body.toString("base64");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const r = await entregarPastaMonitorada(
      { loteId: "t2", evidenciaEstrategia: "NENHUMA", timeoutImportacaoSeg: 1 },
      { pastaCarga: pasta, encoding: "WINDOWS-1252", intervaloPollingBakMs: 50 },
      [{ nome: "TXITENS.TXT", conteudoBase64: b64, sha256: sha }],
    );
    assert.equal(r.status, "ENTREGUE_SEM_CONFIRMACAO");
    assert.equal(fs.existsSync(path.join(pasta, "ITENSMGV.TXT")), false);
    assert.ok(fs.existsSync(path.join(pasta, "TXITENS.TXT")));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test("entrega ITENSMGV quarentena TXITENS antes de gravar", async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "balanca-itensmgv-"));
  try {
    fs.writeFileSync(path.join(pasta, "TXITENS.TXT"), "residual-classic");
    const body = Buffer.from("ITENSMGV-LINE-150");
    const b64 = body.toString("base64");
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    const r = await entregarPastaMonitorada(
      { loteId: "t1", evidenciaEstrategia: "NENHUMA", timeoutImportacaoSeg: 1 },
      { pastaCarga: pasta, encoding: "WINDOWS-1252", intervaloPollingBakMs: 50 },
      [{ nome: "ITENSMGV.TXT", conteudoBase64: b64, sha256: sha }],
    );
    assert.equal(r.status, "ENTREGUE_SEM_CONFIRMACAO");
    assert.equal(fs.existsSync(path.join(pasta, "TXITENS.TXT")), false);
    assert.ok(fs.existsSync(path.join(pasta, "ITENSMGV.TXT")));
    const orphanFiles = fs.readdirSync(path.join(pasta, "_margin_orphan"));
    assert.ok(orphanFiles.some((n) => /TXITENS/i.test(n)));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});
