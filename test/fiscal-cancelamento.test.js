"use strict";
/**
 * Cancelamento de NFC-e: leitura da resposta da ACBrLib (bloco "Cancelamento"), avaliação do cStat e
 * confirmação de "já cancelada". Caso real (BR/MG, 03/11/2026): a SEFAZ respondia 573 e o agente lia
 * cStat vazio e devolvia ok — o PDV seguia e o backend recusava (409).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const acbr = require("../acbr");
const { _testCancelamento } = require("../fiscalService");

const resposta573 = JSON.stringify({
  Cancelamento: {
    Arquivo: "", CNPJDest: "", CStat: 573, CUF: 31, DhRecbto: "2026-11-04T00:11:59.000Z", Msg: "",
    VerAplic: "W-1.6.27", Versao: "W-1.6.27",
    XML: "<infEvento><tpAmb>1</tpAmb><cStat>573</cStat><xMotivo>Rejeição: Duplicidade de Evento</xMotivo><chNFe>31261141385387000129650010000000071021368907</chNFe><tpEvento>110111</tpEvento></infEvento>",
    XMotivo: "Rejeição: Duplicidade de Evento", chNFe: "31261141385387000129650010000000071021368907",
    emailDest: "", nProt: "", nSeqEvento: 1, tpAmb: "1", tpEvento: "110111", xEvento: "CANCELAMENTO",
  },
});

const resposta135 = JSON.stringify({
  Cancelamento: {
    CStat: 135, XMotivo: "Evento registrado e vinculado a NF-e", NProt: "131260000123456",
    chNFe: "31261141385387000129650010000000071021368907", tpEvento: "110111",
  },
});

test("lê o bloco Cancelamento da ACBrLib (cStat, motivo e protocolo)", () => {
  const p = acbr.parseResposta(resposta573);
  assert.equal(p.cStat, "573");
  assert.equal(p.xMotivo, "Rejeição: Duplicidade de Evento");
  const ok = acbr.parseResposta(resposta135);
  assert.equal(ok.cStat, "135");
  assert.equal(ok.protocolo, "131260000123456");
});

test("blocos conhecidos e genérico com CStat; emissão continua lendo Envio", () => {
  assert.equal(acbr.blocoRespostaJson({ Inutilizacao: { CStat: 102 } }).CStat, 102);
  assert.equal(acbr.blocoRespostaJson({ Evento: { CStat: 135 } }).CStat, 135);
  assert.equal(acbr.blocoRespostaJson({ Outro: { CStat: 999 } }).CStat, 999);
  assert.equal(acbr.blocoRespostaJson({ Envio: { CStat: 100 }, Cancelamento: { CStat: 135 } }).CStat, 100);
  assert.equal(acbr.blocoRespostaJson({ semCStat: { a: 1 } }), null);
  assert.equal(acbr.parseResposta(JSON.stringify({ Envio: { CStat: 100, XMotivo: "Autorizado" } })).cStat, "100");
});

test("cancelamento aceito (135/155) e já cancelada (573/218/420)", () => {
  assert.deepEqual(acbr.avaliarCancelamento({ cStat: "135", xMotivo: "ok", protocolo: "1" }),
    { cStat: "135", xMotivo: "ok", protocolo: "1", jaCancelada: false });
  assert.equal(acbr.avaliarCancelamento({ cStat: "155" }).jaCancelada, false);
  for (const c of ["573", "218", "420"]) {
    assert.equal(acbr.avaliarCancelamento({ cStat: c }).jaCancelada, true, c);
  }
});

test("recusa da SEFAZ vira erro permanente com o motivo; resposta sem cStat nunca é sucesso", () => {
  assert.throws(
    () => acbr.avaliarCancelamento({ cStat: "501", xMotivo: "Rejeição: Prazo de Cancelamento Superior ao Previsto" }),
    (err) => err.permanente === true && err.cStat === "501" && /cStat 501/.test(err.message) && /Prazo/.test(err.message),
  );
  assert.throws(
    () => acbr.avaliarCancelamento({ cStat: "" }),
    (err) => err.permanente === false && /sem código/.test(err.message),
  );
});

test("já cancelada: consulta confirma, autorizada falha, consulta indisponível não bloqueia", async () => {
  const res = { cStat: "573", xMotivo: "Duplicidade", jaCancelada: true };
  await _testCancelamento.confirmarJaCancelada({ consultarChave: async () => ({ cStat: "101", situacao: "CANCELADA" }) }, "x", res);
  await _testCancelamento.confirmarJaCancelada({ consultarChave: async () => { throw new Error("SEFAZ fora"); } }, "x", res);
  await assert.rejects(
    _testCancelamento.confirmarJaCancelada({ consultarChave: async () => ({ cStat: "100", situacao: "AUTORIZADA" }) }, "x", res),
    /consulta mostra a nota autorizada/,
  );
});

test("payload ao backend: XML só no cancelamento real; motivo da SEFAZ com fallback", () => {
  const real = _testCancelamento.payloadCancelamentoBackend({ cStat: "135", protocolo: "9", xml: "<x/>", xMotivo: "ok" }, "m");
  assert.equal(real.xmlContent, "<x/>");
  assert.equal(real.jaCancelada, false);
  const ja = _testCancelamento.payloadCancelamentoBackend({ cStat: "573", xml: "<rej/>", jaCancelada: true }, "motivo op");
  assert.equal(ja.xmlContent, null);
  assert.equal(ja.xMotivo, "motivo op");
  assert.equal(ja.jaCancelada, true);
});
