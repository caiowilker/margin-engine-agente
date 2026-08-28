const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pollDelayMs } = require("../scripts/installer-wait-online");

describe("installer-wait-online — sondagem adaptativa", () => {
  it("sonda rápido nos primeiros 10s", () => {
    assert.equal(pollDelayMs(0), 300);
    assert.equal(pollDelayMs(9_999), 300);
  });

  it("acelera gradualmente até 2s após 30s", () => {
    assert.equal(pollDelayMs(10_000), 750);
    assert.equal(pollDelayMs(29_999), 750);
    assert.equal(pollDelayMs(30_000), 2000);
    assert.equal(pollDelayMs(120_000), 2000);
  });
});
