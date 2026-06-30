// Testes — normalização de respostas ACBr (cStat lote vs infProt)
const assert = require("assert");
const {
  coalescerRespostaAcbr,
  resolverCStatFinal,
  isCStatAutorizado,
  deveIgnorarCStatConsultaPosEmissao,
} = require("../acbrResposta");
const { parseResposta } = require("../acbr");
const { parseRespostaLib } = require("../acbrLibResposta");

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

test("isCStatAutorizado — somente 100 e 150", () => {
  assert.strictEqual(isCStatAutorizado("100"), true);
  assert.strictEqual(isCStatAutorizado("150"), true);
  assert.strictEqual(isCStatAutorizado("104"), false);
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
  assert.strictEqual(isCStatAutorizado(p.cStat), false);
});

test("consulta 217 após lote 104 — não tratar como rejeição da emissão", () => {
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("104", "217"), true);
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("100", "217"), false);
  assert.strictEqual(deveIgnorarCStatConsultaPosEmissao("104", "598"), false);
});

test("parseRespostaLib — alinha cStat/chave com Monitor", () => {
  const raw =
    "cStat=100\nxMotivo=Autorizado o uso da NF-e\nChaveNFe=31260612343055000183650010000000091816823438\nnProt=131260000583869";
  const pMon = parseResposta(raw);
  const pLib = parseRespostaLib(raw);
  assert.strictEqual(pLib.cStat, pMon.cStat);
  assert.strictEqual(pLib.chave, pMon.chave);
  assert.strictEqual(pLib.protocolo, pMon.protocolo);
  assert.strictEqual(pLib.native, true);
});

test("parseRespostaLib — evento cStat 135", () => {
  const p = parseRespostaLib("cStat=135\nxMotivo=Evento registrado e vinculado a NF-e\nnProt=131260000999999");
  assert.strictEqual(p.cStat, "135");
  assert.match(p.xMotivo || "", /Evento registrado/);
});

test("parseRespostaLib — JSON Envio cStat 100 (ACBrLib TipoResposta=2)", () => {
  const raw = JSON.stringify({
    Envio: {
      CStat: 100,
      Msg: "Autorizado o uso da NF-e",
      NProt: "131260000589089",
      NFe62: {
        cStat: 100,
        chDFe: "31260612343055000183650010000000621739664439",
        nProt: "131260000589089",
        xMotivo: "Autorizado o uso da NF-e",
      },
    },
  });
  const p = parseRespostaLib(raw);
  assert.strictEqual(p.cStat, "100");
  assert.strictEqual(p.chave, "31260612343055000183650010000000621739664439");
  assert.strictEqual(p.protocolo, "131260000589089");
});

test("parseRespostaLib — JSON Status cStat 107", () => {
  const raw = JSON.stringify({
    Status: {
      CStat: 107,
      XMotivo: "Serviço em Operação",
      tpAmb: "2",
    },
  });
  const p = parseRespostaLib(raw);
  assert.strictEqual(p.cStat, "107");
  assert.match(p.xMotivo || "", /Operação/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
