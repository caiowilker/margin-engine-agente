/**
 * Preflight INI + dhCont não sobrescrito na preparação para emissão.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const iniPreflight = require("../fiscal/iniPreflight");
const dh = require("../fiscal/fiscalDhEmiIni");
const {
  escreverIniOffline,
  aplicarTpEmisOffline,
} = require("../fiscal/contingenciaOffline");

function iniNfceMinimo(overrides = {}) {
  return `[infNFe]
versao=4.00

[Identificacao]
cNF=12345678
mod=65
serie=1
nNF=10
tpEmis=1
tpAmb=2
finNFe=1

[Emitente]
CNPJCPF=11222333000181
xNome=EMPRESA TESTE
CRT=1

[Produto001]
CFOP=5102
cProd=1
xProd=Item
NCM=19059090
uCom=UN
qCom=1.0000
vUnCom=100.0000
vProd=100.00
indTot=1

[Total]
vNF=100.00
vBC=0.00
vICMS=0.00
vBCST=0.00
vST=0.00
vProd=100.00
vFrete=0.00
vSeg=0.00
vDesc=0.00
vII=0.00
vIPI=0.00
vPIS=0.00
vCOFINS=0.00
vOutro=0.00
vTotTrib=0.00

${overrides.extra || ""}
`;
}

test("prepararIniParaEmissao NÃO sobrescreve dhCont (janela contig)", () => {
  const ini = `[Identificacao]
dhEmi=2026-06-30T10:00:00-03:00
dhCont=14/08/2026 12:00:00
xJust=Falha de comunicacao com a SEFAZ
tpEmis=9
`;
  const out = dh.prepararIniParaEmissao(ini);
  assert.match(out, /dhCont=14\/08\/2026 12:00:00/);
  assert.match(out, /dhEmi=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
  // dhEmi foi para "agora"; dhCont permanece a janela.
  assert.doesNotMatch(out, /dhCont=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\n.*dhCont=/);
  const dhContLine = out.split(/\r?\n/).find((l) => /^dhCont=/i.test(l));
  assert.equal(dhContLine, "dhCont=14/08/2026 12:00:00");
});

test("prepararIniParaEmissao normaliza dhCont ISO sem mudar instante", () => {
  const out = dh.normalizarDatasIni(
    "dhCont=2026-08-14T12:00:00-03:00\n",
    { atualizarParaAgora: true },
  );
  assert.match(out, /^dhCont=14\/08\/2026 12:00:00$/m);
});

test("assertTotaisConsistentes: inclui vFCPST na fórmula MOC", () => {
  const ini = iniNfceMinimo().replace(
    "vST=0.00\nvProd=100.00",
    "vST=10.00\nvFCPST=2.00\nvProd=100.00",
  ).replace("vNF=100.00", "vNF=112.00");
  const ok = iniPreflight.assertTotaisConsistentes(ini);
  assert.equal(ok.esperado, 112);
});


test("assertIniNfceEstrutura: exige produto, CNPJ, nNF; offline exige tpEmis=9", () => {
  assert.throws(
    () => iniPreflight.assertIniNfceEstrutura(iniNfceMinimo(), { offline: true }),
    /tpEmis=9/,
  );
  const patched = aplicarTpEmisOffline(iniNfceMinimo(), {
    dhCont: new Date(2026, 7, 14, 12, 0, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  const meta = iniPreflight.assertIniNfceEstrutura(patched, { offline: true });
  assert.equal(meta.mod, "65");
  assert.equal(meta.cnpj, "11222333000181");
});

test("assertIniNfceEstrutura: recusa mod=55", () => {
  assert.throws(
    () =>
      iniPreflight.assertIniNfceEstrutura(
        iniNfceMinimo().replace("mod=65", "mod=55"),
      ),
    /modelo 55/,
  );
});

test("assertIniNfceEstrutura: aceita alias Modelo=", () => {
  const ini = iniNfceMinimo().replace("mod=65", "Modelo=65");
  const meta = iniPreflight.assertIniNfceEstrutura(ini);
  assert.equal(meta.mod, "65");
});

test("escreverIniOffline grava só se estrutura+totais+offline ok", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-off-"));
  const iniPath = path.join(dir, "nfce.ini");
  fs.writeFileSync(iniPath, iniNfceMinimo(), "utf8");
  const dest = escreverIniOffline(iniPath, {
    dhCont: new Date(2026, 7, 14, 12, 0, 0),
    xJust: "Falha de comunicacao com a SEFAZ",
  });
  assert.ok(fs.existsSync(dest));
  const content = fs.readFileSync(dest, "utf8");
  assert.match(content, /tpEmis=9/);
  assert.match(content, /dhCont=14\/08\/2026 12:00:00/);
  assert.match(content, /vProd=100\.00/);

  // Totais quebrados → não grava offline
  const badPath = path.join(dir, "bad.ini");
  fs.writeFileSync(badPath, iniNfceMinimo().replace("vNF=100.00", "vNF=1.00"), "utf8");
  assert.throws(
    () =>
      escreverIniOffline(badPath, {
        dhCont: new Date(2026, 7, 14, 12, 0, 0),
        xJust: "Falha de comunicacao com a SEFAZ",
      }),
    /totais inconsistentes|IniPreflight/i,
  );
  assert.equal(fs.existsSync(badPath.replace(/\.ini$/i, "-offline.ini")), false);
});
