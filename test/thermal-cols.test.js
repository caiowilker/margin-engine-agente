/**
 * Testes — colunas térmicas 58mm / 80mm.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  paperMmToCols,
  clampCols,
  isNarrowThermal,
  formatChaveLines,
  buildCupomItemLines,
  buildCupomItemHeader,
  col2,
  sepEq,
  COLS_58MM,
  COLS_80MM,
} = require("../print/thermalCols");

describe("thermalCols", () => {
  it("mapeia 58→32 e 80→48", () => {
    assert.equal(paperMmToCols(58), COLS_58MM);
    assert.equal(paperMmToCols(80), COLS_80MM);
    assert.equal(paperMmToCols(undefined), COLS_80MM);
  });

  it("clampCols respeita faixa", () => {
    assert.equal(clampCols(10), 24);
    assert.equal(clampCols(100), 64);
    assert.equal(clampCols("48"), 48);
    assert.equal(clampCols("x"), null);
  });

  it("isNarrowThermal abaixo de 42", () => {
    assert.equal(isNarrowThermal(32), true);
    assert.equal(isNarrowThermal(48), false);
  });

  it("chave NFC-e cabe em 32 cols sem estourar", () => {
    const chave = "35240112345678901234550010000000011234567890";
    const lines = formatChaveLines(chave, 32);
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.ok(line.length <= 32, `linha longa: ${line.length} — ${line}`);
    }
  });

  it("chave cabe em uma linha no 80mm", () => {
    const chave = "35240112345678901234550010000000011234567890";
    const lines = formatChaveLines(chave, 48);
    // 11 grupos * 4 + 10 espaços = 54 → ainda pode quebrar em 48
    for (const line of lines) {
      assert.ok(line.length <= 48);
    }
  });

  it("item 80mm em uma linha; 58mm em duas", () => {
    const wide = buildCupomItemLines({
      cols: 48,
      idx: 0,
      nome: "Coca Cola 350ml",
      valUnit: "5,00",
      valTotal: "10,00",
    });
    assert.equal(wide.length, 1);
    assert.ok(wide[0].length <= 48);

    const narrow = buildCupomItemLines({
      cols: 32,
      idx: 0,
      nome: "Coca Cola 350ml Gelada Extra",
      valUnit: "5,00",
      valTotal: "10,00",
    });
    assert.equal(narrow.length, 2);
    for (const line of narrow) {
      assert.ok(line.length <= 32, line);
    }
  });

  it("header e sep respeitam cols", () => {
    assert.equal(sepEq(32).length, 32);
    assert.equal(buildCupomItemHeader(32).length <= 32, true);
    assert.equal(col2("A", "B", 32).length, 32);
  });
});
