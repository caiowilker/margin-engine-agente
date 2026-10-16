"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { quarentenarTxitensResidual, entregarPastaMonitorada } = require("../src/balanca/entrega");

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
