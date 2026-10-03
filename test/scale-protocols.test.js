"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { STX, ETX, ENQ } = require("../src/scale/protocol/enqStx5");
const {
  listProtocols,
  resolveProtocol,
  isSupportedProtocol,
} = require("../src/scale/protocol/registry");
const filizola = require("../src/scale/protocol/filizolaBp");
const urano = require("../src/scale/protocol/urano12");

function frame(payload5) {
  return Buffer.from([STX, ...Buffer.from(payload5, "ascii"), ETX]);
}

describe("scale protocol registry", () => {
  it("lists three supported protocols", () => {
    const list = listProtocols();
    assert.equal(list.length, 3);
    assert.ok(list.some((p) => p.id === "TOLEDO_PRIX3_ENQ_STX5"));
    assert.ok(list.some((p) => p.id === "FILIZOLA_BP_ENQ_STX5"));
    assert.ok(list.some((p) => p.id === "URANO_U12" && p.stopBits === 2));
  });

  it("resolves aliases", () => {
    assert.equal(resolveProtocol("ENQ_STX5").id, "TOLEDO_PRIX3_ENQ_STX5");
    assert.equal(resolveProtocol("FILIZOLA_BP").id, "FILIZOLA_BP_ENQ_STX5");
    assert.equal(resolveProtocol("URANO12").id, "URANO_U12");
  });

  it("strict rejects unknown", () => {
    assert.equal(isSupportedProtocol("XYZ_FAKE"), false);
    assert.throws(
      () => resolveProtocol("XYZ_FAKE", { strict: true }),
      (err) => err.codigo === "SCALE_PROTOCOL_UNSUPPORTED",
    );
  });
});

describe("Filizola BP", () => {
  it("stable / unstable / neg / overload", () => {
    const s = filizola.parseFrame(frame("01250"));
    assert.equal(s.ok, true);
    assert.equal(s.kg, 1.25);
    assert.equal(filizola.parseFrame(frame("IIIII")).status, "unstable");
    assert.equal(filizola.parseFrame(frame("NNNNN")).status, "negative");
    assert.equal(filizola.parseFrame(frame("SSSSS")).status, "overload");
  });

  it("leading space digit", () => {
    const r = filizola.parseFrame(frame(" 0100"));
    assert.equal(r.ok, true);
    assert.equal(r.grams, 100);
  });

  it("no price display", () => {
    assert.equal(filizola.encodePricePerKg(10), null);
  });

  it("enquire ENQ", () => {
    assert.deepEqual(filizola.encodeEnquire(), Buffer.from([ENQ]));
  });
});

describe("Urano12", () => {
  it("stx5 stable", () => {
    const r = urano.parseFrame(frame("02000"));
    assert.equal(r.ok, true);
    assert.equal(r.kg, 2);
    assert.equal(urano.serial.stopBits, 2);
  });

  it("text kg", () => {
    const r = urano.parseFrame(Buffer.from("PESO: 1,250kg", "latin1"));
    assert.equal(r.ok, true);
    assert.equal(r.kg, 1.25);
  });

  it("fragment needMore", () => {
    const r = urano.parseFrame(Buffer.from([STX, 0x31]));
    assert.equal(r.needMore, true);
  });

  it("unstable IIIII", () => {
    assert.equal(urano.parseFrame(frame("IIIII")).status, "unstable");
  });
});
