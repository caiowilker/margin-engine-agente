const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pollDelayMs } = require("../scripts/installer-wait-online");

describe("installer-wait-online — sondagem adaptativa", () => {
  it("sonda muito rápido nos primeiros 5s (pós-update)", () => {
    assert.equal(pollDelayMs(0), 150);
    assert.equal(pollDelayMs(4_999), 150);
  });

  it("sonda rápido até 15s", () => {
    assert.equal(pollDelayMs(5_000), 300);
    assert.equal(pollDelayMs(14_999), 300);
  });

  it("acelera gradualmente até 2s após 30s", () => {
    assert.equal(pollDelayMs(15_000), 750);
    assert.equal(pollDelayMs(29_999), 750);
    assert.equal(pollDelayMs(30_000), 2000);
    assert.equal(pollDelayMs(120_000), 2000);
  });
});
