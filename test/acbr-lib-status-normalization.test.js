const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRespostaLib } = require("../acbrLibResposta");

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
