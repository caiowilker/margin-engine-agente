#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  marcarAposApplyCloud,
  flushPendingAck,
  lerPending,
  limparPending,
} = require("../updaterCloudPending");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

async function main() {
  console.log("\nupdater-cloud-pending\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-pending-"));
  const pendingFile = path.join(tmp, "pending-cloud-update-ack.json");
  const deps = { path: pendingFile };

  await test("marca só origem cloud", () => {
    assert.strictEqual(
      marcarAposApplyCloud({ versaoAlvo: "1.0.2", origem: "auto" }, deps),
      false,
    );
    assert.strictEqual(lerPending(deps), null);
    assert.strictEqual(
      marcarAposApplyCloud({ versaoAlvo: "1.0.2", origem: "cloud" }, deps),
      true,
    );
    assert.strictEqual(lerPending(deps).versaoAlvo, "1.0.2");
  });

  await test("flush OK quando versão confere", async () => {
    marcarAposApplyCloud({ versaoAlvo: "1.0.3", origem: "cloud" }, deps);
    let payload = null;
    const r = await flushPendingAck({
      deps,
      lerVersaoAtual: () => "1.0.3",
      enviarAck: async (p) => {
        payload = p;
      },
    });
    assert.strictEqual(r, "ok");
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(lerPending(deps), null);
  });

  await test("flush divergente se versão não bate", async () => {
    marcarAposApplyCloud({ versaoAlvo: "1.0.4", origem: "cloud" }, deps);
    const r = await flushPendingAck({
      deps,
      lerVersaoAtual: () => "1.0.0",
      enviarAck: async () => {},
    });
    assert.strictEqual(r, "divergente");
    assert.strictEqual(lerPending(deps), null);
  });

  await test("falha de ACK mantém pending", async () => {
    marcarAposApplyCloud({ versaoAlvo: "1.0.5", origem: "cloud" }, deps);
    const r = await flushPendingAck({
      deps,
      lerVersaoAtual: () => "1.0.5",
      enviarAck: async () => {
        throw new Error("rede");
      },
    });
    assert.strictEqual(r, "falha_ack");
    assert.ok(lerPending(deps));
    limparPending(deps);
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {}

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main();
