// Testes — normalização de respostas ACBr (cStat lote vs infProt)
const assert = require("assert");
const {
  coalescerRespostaAcbr,
  resolverCStatFinal,
  isCStatAutorizado,
  deveIgnorarCStatConsultaPosEmissao,
} = require("../acbrResposta");
const { parseResposta } = require("../acbr");

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

console.log("acbr-resposta.test.js\n");

test("coalescerRespostaAcbr — junta array de sessão multi-comando", () => {
  const out = coalescerRespostaAcbr(["OK", "cStat=104"]);
  assert.ok(out.includes("cStat=104"));
});

test("isCStatAutorizado — 104 com chave e protocolo", () => {
  assert.strictEqual(isCStatAutorizado("104", "123", "31260612343055000183650010000000091816823438"), true);
  assert.strictEqual(isCStatAutorizado("104", null, "31260612343055000183650010000000091816823438"), false);
});

test("resolverCStatFinal — prefere cStat 100 do infProt sobre 104 do lote", () => {
  const xml =
    '<?xml version="1.0"?><nfeProc><protNFe><infProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo><nProt>999</nProt><chNFe>31260612343055000183650010000000091816823438</chNFe></infProt></protNFe></nfeProc>';
  const p = parseResposta([`cStat=104\nxMotivo=Lote processado\n${xml}`]);
  assert.strictEqual(p.cStat, "100");
  assert.strictEqual(p.protocolo, "999");
});

test("parseResposta — rejeição real no infProt (cStat 2xx)", () => {
  const xml =
    '<?xml version="1.0"?><nfeProc><protNFe><infProt><cStat>204</cStat><xMotivo>Duplicidade</xMotivo></infProt></protNFe></nfeProc>';
  const p = parseResposta(`cStat=104\n${xml}`);
  assert.strictEqual(p.cStat, "204");
  assert.match(p.xMotivo || "", /Duplicidade/);
});

test("parseResposta — resposta string simples cStat 100", () => {
  const p = parseResposta("cStat=100\nxMotivo=Autorizado o uso da NF-e\nChaveNFe=31260612343055000183650010000000091816823438");
  assert.strictEqual(p.cStat, "100");
  assert.ok(p.chave);
});

test("parseResposta — protocolo no texto (sem XML) com cStat 104", () => {
  const chave = "31260612343055000183650010000000091816823438";
  const p = parseResposta(
    `cStat=104\nxMotivo=Lote processado\nChaveNFe=${chave}\nnProt=23123456789012`,
  );
  assert.strictEqual(p.protocolo, "23123456789012");
  assert.strictEqual(isCStatAutorizado(p.cStat, p.protocolo, p.chave), true);
});

test("consulta 217 após lote 104 — não tratar como rejeição da emissão", () => {
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("104", "217"), true);
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("100", "217"), false);
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("104", "598"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
