const test = require("node:test");
const assert = require("node:assert/strict");

const fiscalMotivo = require("../fiscal/fiscalMotivo");

test("classifica NCM como não recuperável", () => {
  const m = fiscalMotivo.classificarDeMensagem("Produto sem NCM válido");
  assert.equal(m.motivoFiscal, "NCM");
  assert.equal(m.recuperavel, false);
});

test("classifica timeout como recuperável", () => {
  const m = fiscalMotivo.classificarDeMensagem("NFE_Enviar timeout após 90000ms");
  assert.equal(m.motivoFiscal, "TIMEOUT");
  assert.equal(m.recuperavel, true);
});

test("classifica rede como recuperável", () => {
  const m = fiscalMotivo.classificarDeMensagem("ECONNRESET ao conectar SEFAZ");
  assert.equal(m.motivoFiscal, "NETWORK");
  assert.equal(m.recuperavel, true);
});

test("statusFiscalFailSafe retorna PENDENTE_FISCAL para erros recuperáveis", () => {
  const err = new Error("timeout na emissão");
  err.recuperavel = true;
  assert.equal(fiscalMotivo.statusFiscalFailSafe(err), "PENDENTE_FISCAL");
});

test("enriquecerStatusEmissao inclui motivoFiscal", () => {
  const st = fiscalMotivo.enriquecerStatusEmissao({
    correlationId: "c1",
    status: "FALHA_TEMPORARIA",
    erro: "SEFAZ indisponível cStat 999",
  });
  assert.equal(st.motivoFiscal, "SEFAZ");
  assert.equal(st.recuperavel, true);
  assert.ok(st.acaoSugerida);
});
