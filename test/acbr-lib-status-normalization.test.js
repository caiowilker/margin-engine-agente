const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseRespostaLib,
  parseRetConsStatServXml,
  isHollowStatusJson,
} = require("../acbrLibResposta");

test("parseRespostaLib preserva raw de status estruturado", () => {
  const parsed = parseRespostaLib({
    operacional: false,
    cStat: "0",
    xMotivo: "timeout de transporte",
    raw: "",
  });
  assert.equal(parsed.cStat, "0");
  assert.match(String(parsed.raw), /timeout de transporte/);
  assert.doesNotMatch(String(parsed.raw), /\[object Object\]/);
});

test("parseRespostaLib lê resposta JSON nativa", () => {
  const parsed = parseRespostaLib('{"Status":{"CStat":107,"XMotivo":"Servico em Operacao"}}');
  assert.equal(parsed.cStat, "107");
  assert.equal(parsed.xMotivo, "Servico em Operacao");
});

test("JSON Status oco (CStat 0) é detectado — ACBrLib bug de serialização", () => {
  const hollow = parseRespostaLib(
    '{ "Status" : { "CStat" : 0, "CUF" : 0, "XMotivo" : "", "tpAmb" : "1" } }',
  );
  assert.equal(isHollowStatusJson(hollow), true);
});

test("parseRetConsStatServXml lê 107 do XML WS real", () => {
  const xml =
    '<?xml version="1.0"?><retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
    "<tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Serviço em Operação</xMotivo><cUF>31</cUF>" +
    "</retConsStatServ>";
  const p = parseRetConsStatServXml(xml);
  assert.equal(p.cStat, "107");
  assert.match(p.xMotivo || "", /Opera/i);
  assert.equal(p.tpAmb, "2");
});
