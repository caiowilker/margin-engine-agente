const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("emissão — hot path solidez/velocidade", () => {
  it("persistNativeEmissaoOutputs não gera PDF NFC-e por padrão", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "fiscal/drivers/acbrLibDriver.js"),
      "utf8",
    );
    assert.match(src, /function deveGerarPdfNaPersistenciaEmit/);
    assert.match(src, /FISCAL_GERAR_PDF_ON_EMIT/);
    assert.match(src, /pdfSkipped: true/);
    assert.match(src, /Probe StatusServico skip/);
    assert.match(src, /err\.incerto = true/);
  });

  it("preflight exige cStat 107 apenas", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "fiscalPreflight.js"),
      "utf8",
    );
    assert.match(src, /cStat !== "107"/);
    assert.doesNotMatch(src, /cStat !== "107" && cStat !== "108"/);
  });

  it("StatusServico operacional só 107", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "fiscal/drivers/acbrLibDriver.js"),
      "utf8",
    );
    assert.match(src, /const operacional = p\.cStat === "107"/);
  });

  it("dedup correlationId inclui RECUPERANDO", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "filaFiscal.js"),
      "utf8",
    );
    assert.match(
      src,
      /correlation_id = \?[\s\S]*RECUPERANDO/,
    );
  });

  it("MAX_BUMP_539 default ≤ 3", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "fiscalService.js"),
      "utf8",
    );
    assert.match(src, /FISCAL_MAX_BUMP_539 \|\| "3"/);
  });

  it("CALLBACK_BACKEND tem worker separado do mutex de emissão", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "filaFiscal.js"),
      "utf8",
    );
    assert.match(src, /processandoCallback/);
    assert.match(src, /flag: "processandoCallback"/);
    assert.match(src, /CALLBACK_WORKER_MS/);
    assert.match(src, /CALLBACK continua sob fila pausada/);
    assert.match(src, /jobsEmVooIds/);
    assert.match(src, /tipo = 'EMISSAO'/); // contingência não puxa CALLBACK
    assert.doesNotMatch(
      src,
      /apenasTipos: \["EMISSAO", "CALLBACK_BACKEND"\]/,
    );
  });

  it("stale CALLBACK/PDF reabre PENDENTE (não INCERTO dead-letter)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "filaFiscal.js"),
      "utf8",
    );
    assert.match(src, /Job \$\{tipo\} travado em PROCESSANDO — reaberto/);
    assert.match(src, /tipo === "CALLBACK_BACKEND"/);
  });

  it("cancelar PROCESSANDO vira INCERTO (não FALHA_PERMANENTE)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "filaFiscal.js"),
      "utf8",
    );
    assert.match(src, /status = 'INCERTO'[\s\S]*status = 'PROCESSANDO'/);
    assert.match(
      src,
      /status IN \('PENDENTE', 'FALHA_TEMPORARIA'\)/,
    );
  });
});
