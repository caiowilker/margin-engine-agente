const { test } = require("node:test");
const assert = require("node:assert/strict");
const fiscalRetry = require("../fiscalRetry");
const fiscalRecuperacao = require("../fiscalRecuperacao");

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

test("podeRecuperarChaveParaVenda — 539 não reutiliza nota de outra venda", () => {
  const chave = "31260612343055000183650010000000091816823438";
  assert.equal(
    fiscalRecuperacao.podeRecuperarChaveParaVenda(chave, "PDV-NOVA"),
    false,
  );
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

test("consultarDocumentoAutorizado — 539 não recupera XML local de outra venda", async () => {
  const docs = require("../documentosFiscais");
  const chave = "31260612343055000183650010000000101989046230";
  const xmlJunho =
    '<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe' +
    chave +
    '"/></NFe><protNFe><infProt><cStat>100</cStat><nProt>131260000562650</nProt></infProt></protNFe></nfeProc>';
  const origLocalizar = docs.localizarXmlPorChave;
  docs.localizarXmlPorChave = () => ({
    xml: xmlJunho,
    path: "C:\\ProgramData\\MarginEngine\\acbr\\backup\\fake-procNFe.xml",
    prot: { cStat: "100", nProt: "131260000562650" },
  });
  try {
    const out = await fiscalRecuperacao.verificarAntesDeEmitir({
      chave,
      numeroVenda: "PDV1783128174812",
      correlationId: "3fd8e97b-b174-452e-82eb-38f69be70b31",
      modoDuplicidade539: true,
    });
    assert.equal(out, null);
  } finally {
    docs.localizarXmlPorChave = origLocalizar;
  }
});

test("bootstrapDesdeXmlCanonicos — rebaixa contador SQLite quando xml canônico é menor", () => {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const fiscalNumeracao = require("../fiscalNumeracao");
  const { getDirectoryManager } = require("../runtime/directoryManager");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfce-xml-"));
  const prevXml = process.env.ACBR_XML_DIR;
  const prevDb = process.env.FISCAL_NUMERACAO_DB;
  process.env.ACBR_XML_DIR = tmp;
  process.env.FISCAL_NUMERACAO_DB = path.join(tmp, "numeracao.db");

  try {
    getDirectoryManager().resetForTests?.();
    fiscalNumeracao.definirUltimoNumero("1", 9, "65");
    const chave = "31260712343055000183650010000000021000000010";
    fs.writeFileSync(path.join(tmp, `${chave}-procNFe.xml`), "<nfeProc/>", "utf8");

    const { PATHS } = require("../marginPaths");
    const origXml = PATHS.xml;
    PATHS.xml = tmp;

    const max = fiscalNumeracao.bootstrapDesdeXmlCanonicos("1", "65");
    assert.equal(max, 2);
    assert.equal(fiscalNumeracao.consultarUltimo("1", "65"), 2);

    PATHS.xml = origXml;
  } finally {
    if (prevXml === undefined) delete process.env.ACBR_XML_DIR;
    else process.env.ACBR_XML_DIR = prevXml;
    if (prevDb === undefined) delete process.env.FISCAL_NUMERACAO_DB;
    else process.env.FISCAL_NUMERACAO_DB = prevDb;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
