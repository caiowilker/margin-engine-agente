// Testes — localização de XML aninhado (ACBr Monitor)
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-test-xml");
const xmlRoot = path.join(testDir, "acbr", "xml");
const chave = "31260612343055000183550010000000061982832110";
const cnpj = "12343055000183";

function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) rmDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

rmDir(testDir);
fs.mkdirSync(path.join(xmlRoot, cnpj, "NFe", "202606", "NFe"), { recursive: true });

const nfeOnly = `<?xml version="1.0"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${chave}"/></NFe>`;
const nfeProc = `<?xml version="1.0"?><nfeProc><NFe/><protNFe><infProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo><nProt>23123456789012</nProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`;

fs.writeFileSync(path.join(xmlRoot, cnpj, "NFe", "202606", "NFe", `${chave}-nfe.xml`), nfeOnly);
fs.writeFileSync(
  path.join(xmlRoot, cnpj, "NFe", "202606", "NFe", `${chave}-procNFe.xml`),
  nfeProc,
);

process.env.MARGIN_ENGINE_ROOT = testDir;

const docs = require("../documentosFiscais");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("documentos-xml.test.js\n");

test("localizarXmlPorChave — encontra pasta aninhada ACBr", () => {
  const r = docs.localizarXmlPorChave(chave);
  assert.ok(r, "deveria encontrar XML");
  assert.ok(r.path.includes(chave), "path contém chave");
});

test("localizarXmlPorChave — prefere procNFe com cStat 100", () => {
  const r = docs.localizarXmlPorChave(chave);
  assert.strictEqual(r.prot.cStat, "100");
  assert.strictEqual(r.prot.nProt, "23123456789012");
});

test("resolverXmlParaImpressao — ignora hint sem protocolo se proc existir", () => {
  const hintSemProt = path.join(xmlRoot, cnpj, "NFe", "202606", "NFe", `${chave}-nfe.xml`);
  const resolved = docs.resolverXmlParaImpressao(chave, hintSemProt);
  assert.ok(resolved.includes("procNFe"), "deveria usar XML com protocolo");
});

test("xmlEstaAutorizado — detecta infProt", () => {
  assert.strictEqual(docs.xmlEstaAutorizado(nfeProc), true);
  assert.strictEqual(docs.xmlEstaAutorizado(nfeOnly), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
