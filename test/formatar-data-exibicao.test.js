const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDataExibicao,
  formatarDataHoraExibicao,
  formatarDatasEmTexto,
} = require("../formatarDataExibicao");

test("SQLite com espaço é UTC", () => {
  const d = parseDataExibicao("2026-07-16 14:30:00");
  assert.equal(d.toISOString(), "2026-07-16T14:30:00.000Z");
});

test("ISO Z preserva instante", () => {
  assert.equal(
    parseDataExibicao("2026-07-16T14:30:00.000Z").toISOString(),
    "2026-07-16T14:30:00.000Z",
  );
});

test("formatar não gera Invalid Date", () => {
  const out = formatarDataHoraExibicao("2026-07-16 14:30:00");
  assert.match(out, /^\d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  assert.doesNotMatch(out, /Invalid/);
});

test("texto composto do diagnóstico", () => {
  const out = formatarDatasEmTexto("2026-07-16 14:30:00 · venda X · CONCLUIDO");
  assert.match(out, /venda X · CONCLUIDO$/);
  assert.doesNotMatch(out, /2026-07-16/);
});
