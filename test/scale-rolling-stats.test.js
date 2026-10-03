"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRollingStats } = require("../src/scale/rollingStats");

describe("scale rollingStats", () => {
  it("tracks ok latencies and percentiles", () => {
    const r = createRollingStats(10);
    for (const ms of [10, 20, 30, 40, 100]) r.recordOk(ms);
    const snap = r.snapshot();
    assert.equal(snap.readsOk, 5);
    assert.equal(snap.readsFail, 0);
    assert.equal(snap.p50LatencyMs, 30);
    assert.ok(snap.p95LatencyMs >= 40);
  });

  it("tracks fail and overlap separately", () => {
    const r = createRollingStats(10);
    r.recordFail("SCALE_TIMEOUT");
    r.recordOverlapSkip();
    const snap = r.snapshot();
    assert.equal(snap.readsFail, 1);
    assert.equal(snap.overlapSkips, 1);
    assert.equal(snap.lastCodigo, "SCALE_BUSY");
  });

  it("caps window size", () => {
    const r = createRollingStats(5);
    for (let i = 1; i <= 7; i++) r.recordOk(i);
    assert.equal(r.snapshot().samples, 5);
  });
});
