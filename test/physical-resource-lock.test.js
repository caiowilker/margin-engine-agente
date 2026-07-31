#!/usr/bin/env node
/** physicalResourceLock — serialização + reentrância + topology */
const assert = require("assert");
const lock = require("../runtime/physicalResourceLock");
const map = require("../runtime/physicalResourceMap");

async function run() {
  lock.resetForTests();

  const order = [];
  const a = lock.run("k1", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 40));
    order.push("a-end");
    return 1;
  }, "a");
  const b = lock.run("k1", async () => {
    order.push("b-start");
    order.push("b-end");
    return 2;
  }, "b");
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra, 1);
  assert.strictEqual(rb, 2);
  assert.deepStrictEqual(order, ["a-start", "a-end", "b-start", "b-end"]);

  // Reentrante
  let nested = false;
  await lock.run("k2", async () => {
    await lock.run("k2", async () => {
      nested = true;
    });
  });
  assert.strictEqual(nested, true);

  // Keys distintas não serializam
  const t0 = Date.now();
  await Promise.all([
    lock.run("x", async () => new Promise((r) => setTimeout(r, 50))),
    lock.run("y", async () => new Promise((r) => setTimeout(r, 50))),
  ]);
  assert.ok(Date.now() - t0 < 90, "keys distintas devem sobrepor");

  process.env.PHYSICAL_USB_TOPOLOGY = "separate";
  assert.strictEqual(map.resolvePosprinterKey(), "posprinter");
  assert.strictEqual(map.resolveNfeKey(), "nfe");
  assert.notStrictEqual(map.resolvePosprinterKey(), map.resolveNfeKey());

  process.env.PHYSICAL_USB_TOPOLOGY = "shared";
  assert.strictEqual(map.resolvePosprinterKey(), "usb-shared");
  assert.strictEqual(map.resolveNfeKey(), "usb-shared");

  delete process.env.PHYSICAL_USB_TOPOLOGY;
  lock.resetForTests();
  console.log("physical-resource-lock.test.js OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
