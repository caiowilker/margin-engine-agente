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

test("formatar ISO Z no fuso da loja (America/Sao_Paulo)", () => {
  const out = formatarDataHoraExibicao("2026-07-16T17:30:00.000Z", { comSegundos: true });
  assert.equal(out, "16/07/2026 14:30:00");
});

test("LocalDateTime com T sem fuso permanece relógio de parede", () => {
  const out = formatarDataHoraExibicao("2026-08-12T15:28:32", { comSegundos: true });
  assert.equal(out, "12/08/2026 15:28:32");
});

test("texto composto do diagnóstico", () => {
  const out = formatarDatasEmTexto("2026-07-16 14:30:00 · venda X · CONCLUIDO");
  assert.match(out, /venda X · CONCLUIDO$/);
  assert.doesNotMatch(out, /2026-07-16/);
});
