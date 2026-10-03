"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { STX, ETX, ENQ, ACK } = require("../src/scale/protocol/enqStx5");
const { createMockTransport } = require("../src/scale/transport/serialPort");
const { createSessionManager } = require("../src/scale/session");
const { createDriver } = require("../src/scale/driver");
const { ScaleError } = require("../src/scale/errors");
const physicalLock = require("../runtime/physicalResourceLock");

function weightFrame(digits5) {
  return Buffer.from([STX, ...Buffer.from(digits5, "ascii"), ETX]);
}

describe("scale session + driver", () => {
  let tmpConfig;
  let sessionManager;
  let driver;
  let respondFn;

  beforeEach(() => {
    physicalLock.resetForTests();
    tmpConfig = path.join(os.tmpdir(), `scale-cfg-${Date.now()}.json`);
    process.env.SCALE_CONFIG_OVERRIDE = tmpConfig;
    respondFn = (written) => {
      if (written[0] === ENQ) return weightFrame("01250");
      if (written[0] === STX) return Buffer.from([ACK]);
      return null;
    };
    const factory = () =>
      createMockTransport({
        respond: (w) => respondFn(w),
      });
    sessionManager = createSessionManager({ createTransport: factory });
    driver = createDriver({
      sessionManager,
      createTransport: factory,
    });
  });

  afterEach(async () => {
    await sessionManager.closeSession({ reason: "test" });
    sessionManager._reset();
    physicalLock.resetForTests();
    try {
      fs.unlinkSync(tmpConfig);
    } catch (_) {
      /* ignore */
    }
    delete process.env.SCALE_CONFIG_OVERRIDE;
  });

  it("open session once and read stable weight", async () => {
    const sess = await sessionManager.openSession({
      porta: "COM_TEST",
      baud: 9600,
      protocol: "ENQ_STX5",
    });
    assert.ok(sess.sessionId);
    const r = await driver.readWeight({ sessionId: sess.sessionId });
    assert.equal(r.ok, true);
    assert.equal(r.kg, 1.25);
    assert.equal(r.stable, true);
    assert.equal(sessionManager.get().open, true);
  });

  it("returns unstable without throwing", async () => {
    respondFn = (written) => {
      if (written[0] === ENQ) return weightFrame("IIIII");
      return null;
    };
    const sess = await sessionManager.openSession({
      porta: "COM_TEST",
      baud: 9600,
    });
    const r = await driver.readWeight({ sessionId: sess.sessionId });
    assert.equal(r.ok, false);
    assert.equal(r.codigo, "SCALE_UNSTABLE");
  });

  it("testOnce open+read+close", async () => {
    const r = await driver.testOnce({ porta: "COM_TEST", baud: 9600 });
    assert.equal(r.ok, true);
    assert.equal(r.grams, 1250);
  });

  it("session closed rejects read", async () => {
    await assert.rejects(
      () => driver.readWeight({ sessionId: "x" }),
      (err) => err instanceof ScaleError && err.codigo === "SCALE_SESSION_CLOSED",
    );
  });

  it("closeSession com sessionId errado não derruba COM atual", async () => {
    const sess = await sessionManager.openSession({
      porta: "COM_TEST",
      baud: 9600,
      protocol: "ENQ_STX5",
    });
    const r = await sessionManager.closeSession({
      reason: "stale",
      sessionId: "deadbeefdeadbeef",
    });
    assert.equal(r.closed, false);
    assert.equal(r.skipped, true);
    assert.equal(sessionManager.get()?.sessionId, sess.sessionId);
    assert.equal(sessionManager.get()?.open, true);
  });

  it("maps PHYSICAL_LOCK_WAIT_TIMEOUT to SCALE_LOCK_WAIT_TIMEOUT", () => {
    const { toScaleError } = require("../src/scale/errors");
    const err = new Error("timeout");
    err.code = "PHYSICAL_LOCK_WAIT_TIMEOUT";
    const mapped = toScaleError(err);
    assert.equal(mapped.codigo, "SCALE_LOCK_WAIT_TIMEOUT");
    assert.equal(mapped.http, 503);
  });

  it("queued waiter hits waitMs timeout before acquire", async () => {
    physicalLock.resetForTests();
    let releaseSlow;
    const slow = new Promise((r) => {
      releaseSlow = r;
    });
    // Chain: block the lock tail with a pending promise *before* depth rises
    // by injecting via a first run that starts slowly.
    const pSlow = physicalLock.run("scale:WAIT", () => slow, "slow");
    // Immediately queue waiter (depth still 0 → goes to tail + wait race)
    const waiterPromise = physicalLock.run(
      "scale:WAIT",
      async () => "should-not-run",
      "waiter",
      { waitMs: 40 },
    );
    await assert.rejects(
      () => waiterPromise,
      (err) => err && err.code === "PHYSICAL_LOCK_WAIT_TIMEOUT",
    );
    releaseSlow();
    await pSlow;
  });
});

