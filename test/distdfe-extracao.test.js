"use strict";
/**
 * DistDFe por último NSU — extração de documentos em todos os formatos que a ACBrLib/Monitor
 * devolve. Página cStat 138 com documento não extraído trava o NSU para sempre.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const acbr = require("../acbr");
const { extrairDocsDistribuicaoDFe } = require("../acbrLibResposta");

const CHAVE = "35260611222333000181550010000000301025012345";
const CHAVE2 = "35260611222333000181550010000000311025012346";
const NFE_PROC = `<nfeProc versao="4.00"><NFe><infNFe Id="NFe${CHAVE}" versao="4.00"><ide/></infNFe></NFe></nfeProc>`;
const RES_NFE = `<resNFe versao="1.01"><chNFe>${CHAVE2}</chNFe><CNPJ>12345678000190</CNPJ><xNome>FORN</xNome></resNFe>`;

test("JSON com XML escapado: um documento por chave, sem cópia quebrada", () => {
  const raw = JSON.stringify({
    DistribuicaoDFe: { CStat: 138, XMotivo: "Documento localizado", ultNSU: "10", maxNSU: "12" },
    ResDFe001: { chDFe: CHAVE, XML: NFE_PROC },
    ResDFe002: { chDFe: CHAVE2, XML: RES_NFE },
  });
  const p = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
  assert.strictEqual(p.cStat, "138");
  assert.strictEqual(p.xmls.length, 1);
  assert.ok(!p.xmls[0].includes('\\"'), "XML não pode vir com aspas escapadas");
  assert.strictEqual(p.resumos.length, 1);
  assert.strictEqual(p.ultNsuFinal, "10");
});

test("JSON com nome de bloco diferente de ResDFe (ex.: ProcNFe001) é reconhecido pelo conteúdo", () => {
  const raw = JSON.stringify({
    DistribuicaoDFe: { CStat: 138, ultNSU: "5", maxNSU: "5" },
    ProcNFe001: { XML: NFE_PROC, schema: "procNFe_v4.00.xsd" },
  });
  const p = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
  assert.strictEqual(p.xmls.length, 1);
});

test("docZip base64 (gzip) é descompactado", () => {
  const docZip = zlib.gzipSync(Buffer.from(NFE_PROC, "utf8")).toString("base64");
  const r = extrairDocsDistribuicaoDFe(JSON.stringify({ DocZip001: { docZip, NSU: "7" } }));
  assert.strictEqual(r.xmls.length, 1);
  assert.match(r.xmls[0], /<nfeProc/);
});

test("Arquivo com caminho do XML salvo pela ACBrLib é lido do disco", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distdfe-"));
  const arq = path.join(dir, `${CHAVE}-nfe.xml`);
  fs.writeFileSync(arq, NFE_PROC, "utf8");
  try {
    const r = extrairDocsDistribuicaoDFe(JSON.stringify({ ResDFe001: { chDFe: CHAVE, Arquivo: arq } }));
    assert.strictEqual(r.xmls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resposta INI: seções com XML, resumo sem XML e eventos", () => {
  const raw = [
    "[DistribuicaoDFe]",
    "CStat=138",
    "XMotivo=Documento localizado",
    "ultNSU=000000000004100",
    "maxNSU=000000000004200",
    "[ResDFe001]",
    `chDFe=${CHAVE2}`,
    "CNPJCPF=12345678000190",
    "xNome=FORNECEDOR & CIA",
    "vNF=150.00",
    "schema=resNFe_v1.01.xsd",
    "[ResDFe002]",
    `XML=${NFE_PROC}`,
    "[ResEve001]",
    `chDFe=${CHAVE}`,
    "[ProEve001]",
    `chDFe=${CHAVE}`,
  ].join("\r\n");
  const p = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "4095");
  assert.strictEqual(p.cStat, "138");
  assert.strictEqual(p.xmls.length, 1);
  assert.strictEqual(p.resumos.length, 1);
  assert.match(p.resumos[0], /FORNECEDOR &amp; CIA/);
  assert.ok(p.eventos >= 2);
  assert.strictEqual(p.ultNsuFinal, "000000000004100");
});

test("resumo com chave e XML completo da mesma chave: fica só o XML", () => {
  const raw = JSON.stringify({
    ResDFe001: { chDFe: CHAVE, CNPJCPF: "12345678000190" },
    ResDFe002: { XML: NFE_PROC },
  });
  const p = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
  assert.strictEqual(p.xmls.length, 1);
  assert.strictEqual(p.resumos.length, 0);
});

test("bloco sem documento reconhecível vai para naoClassificados (diagnóstico)", () => {
  const r = extrairDocsDistribuicaoDFe(JSON.stringify({ ResDFe001: { NSU: "9", Foo: "bar" } }));
  assert.deepStrictEqual(r.naoClassificados, ["ResDFe001"]);
  assert.strictEqual(r.xmls.length + r.resumos.length, 0);
});

test("formato legado com XML inline no texto continua funcionando", () => {
  const raw =
    `cStat=138\nxMotivo=Documento localizado\nultNSU=5\nmaxNSU=9\n` +
    `<nfeProc><NFe Id="NFe${CHAVE}"></NFe></nfeProc>` +
    `<resNFe><chNFe>${CHAVE2}</chNFe><CNPJ>12345678000190</CNPJ></resNFe>`;
  const p = acbr.parseDistribuicaoDFeUltNsuResposta(raw, "0");
  assert.strictEqual(p.xmls.length, 1);
  assert.strictEqual(p.resumos.length, 1);
});
