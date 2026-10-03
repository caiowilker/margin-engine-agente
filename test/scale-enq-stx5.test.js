"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseFrame,
  extractFrame,
  encodePricePerKg,
  enqByte,
  STX,
  ETX,
  ENQ,
  STATUS,
} = require("../src/scale/protocol/enqStx5");

function frame(payload5) {
  return Buffer.from([STX, ...Buffer.from(payload5, "ascii"), ETX]);
}

describe("enqStx5 parseFrame", () => {
  it("stable 14.385 kg", () => {
    const r = parseFrame(frame("14385"));
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.STABLE);
    assert.equal(r.stable, true);
    assert.equal(r.grams, 14385);
    assert.equal(r.kg, 14.385);
    assert.equal(r.consumed, 7);
  });

  it("stable zero", () => {
    const r = parseFrame(frame("00000"));
    assert.equal(r.ok, true);
    assert.equal(r.kg, 0);
    assert.equal(r.grams, 0);
  });

  it("unstable IIIII", () => {
    const r = parseFrame(frame("IIIII"));
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.UNSTABLE);
    assert.equal(r.stable, false);
    assert.equal(r.kg, null);
  });

  it("negative NNNNN", () => {
    const r = parseFrame(frame("NNNNN"));
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.NEGATIVE);
  });

  it("overload SSSSS", () => {
    const r = parseFrame(frame("SSSSS"));
    assert.equal(r.ok, true);
    assert.equal(r.status, STATUS.OVERLOAD);
  });

  it("fragmentado needMore", () => {
    const partial = Buffer.from([STX, 0x31, 0x32]);
    const r = parseFrame(partial);
    assert.equal(r.ok, false);
    assert.equal(r.needMore, true);
  });

  it("leading noise then frame", () => {
    const buf = Buffer.concat([Buffer.from([0x00, 0xff]), frame("01234")]);
    const r = parseFrame(buf);
    assert.equal(r.ok, true);
    assert.equal(r.grams, 1234);
    assert.equal(r.consumed, 9);
  });

  it("invalid etx", () => {
    const buf = Buffer.from([STX, 0x31, 0x32, 0x33, 0x34, 0x35, 0x04]);
    const r = parseFrame(buf);
    assert.equal(r.ok, false);
    assert.equal(r.needMore, false);
    assert.equal(r.error, "invalid_etx");
  });

  it("invalid payload", () => {
    const r = parseFrame(frame("ABCDE"));
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_payload");
  });

  it("extractFrame leaves rest", () => {
    const buf = Buffer.concat([frame("00100"), Buffer.from([0x05])]);
    const { parsed, rest } = extractFrame(buf);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.grams, 100);
    assert.equal(rest.length, 1);
    assert.equal(rest[0], ENQ);
  });
});

describe("enqStx5 encode", () => {
  it("enq byte", () => {
    assert.deepEqual(enqByte(), Buffer.from([ENQ]));
  });

  it("price per kg 12.34 → 001234", () => {
    const f = encodePricePerKg(12.34);
    assert.equal(f[0], STX);
    assert.equal(f[7], ETX);
    assert.equal(f.subarray(1, 7).toString("ascii"), "001234");
  });
});
