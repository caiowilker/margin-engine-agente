const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fiscalRetry = require("../fiscalRetry");

describe("fiscalRetry — timeout emissão = INCERTO (não reemitir)", () => {
  it("NFE_Enviar timeout é incerto, não transient", () => {
    const err = new Error("[ACBrLib] NFE_Enviar timeout após 120000ms — verifique SEFAZ");
    assert.equal(fiscalRetry.isIncerto(err), true);
    assert.equal(fiscalRetry.isTransient(err), false);
  });

  it("ACBR_LIB_WORKER_TIMEOUT é incerto", () => {
    const err = new Error("Timeout no worker fiscal (180000ms): emitir");
    err.code = "ACBR_LIB_WORKER_TIMEOUT";
    assert.equal(fiscalRetry.isIncerto(err), true);
    assert.equal(fiscalRetry.isTransient(err), false);
  });

  it("ECONNRESET continua transient (rede, pode retry)", () => {
    const err = new Error("ECONNRESET ao conectar SEFAZ");
    assert.equal(fiscalRetry.isIncerto(err), false);
    assert.equal(fiscalRetry.isTransient(err), true);
  });

  it("err.incerto explícito prevalece", () => {
    const err = new Error("algo");
    err.incerto = true;
    assert.equal(fiscalRetry.isIncerto(err), true);
    assert.equal(fiscalRetry.isTransient(err), false);
  });
});
