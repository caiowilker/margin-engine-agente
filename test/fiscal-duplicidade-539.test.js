const { test } = require("node:test");
const assert = require("node:assert/strict");
const fiscalRetry = require("../fiscalRetry");

test("extrairChaveMotivoDuplicidade — formato SEFAZ [chNFe:…]", () => {
  const msg =
    "Rejeição: Duplicidade de NF-e com diferença na Chave de Acesso [chNFe:31260612343055000183650010000000011372236111][nRec:310000133181128]";
  assert.equal(
    fiscalRetry.extrairChaveMotivoDuplicidade(msg),
    "31260612343055000183650010000000011372236111",
  );
});

test("extrairNumeroSerieDaChave — nNF da chave SEFAZ", () => {
  const chave = "31260612343055000183650010000000091816823438";
  const parsed = fiscalRetry.extrairNumeroSerieDaChave(chave);
  assert.equal(parsed?.numero, 9);
  assert.equal(parsed?.serie, "1");
});

test("isErroDuplicidade539 — detecta cStat e mensagem", () => {
  assert.equal(fiscalRetry.isErroDuplicidade539("cStat 539 duplicidade"), true);
  const err = new Error("NFC-e rejeitada (cStat 539)");
  err.cStat = "539";
  assert.equal(fiscalRetry.isErroDuplicidade539(err), true);
});

test("isPermanente — cStat 539 com duplicidade539 não é permanente imediato", () => {
  const err = new Error("NFC-e rejeitada (cStat 539): Duplicidade");
  err.cStat = "539";
  err.duplicidade539 = true;
  err.permanente = false;
  assert.equal(fiscalRetry.isPermanente(err), false);
});

test("acaoParaCStat 539 — consultar chave", () => {
  assert.equal(fiscalRetry.acaoParaCStat("539"), "consultar_chave");
});
