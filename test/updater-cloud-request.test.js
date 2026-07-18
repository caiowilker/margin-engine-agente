#!/usr/bin/env node
/**
 * Pedido de update remoto via poll de config (cloud → agente).
 */
const assert = require("assert");
const configSync = require("../configSync");

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
  console.log("\nupdater-cloud-request\n");

  await test("sem flag — handler não é chamado", async () => {
    let chamado = 0;
    configSync.setOnUpdateRequested(async () => {
      chamado++;
    });
    await configSync.processarPedidoUpdateCloud(
      { aplicarUpdateQuandoOcioso: false },
      "https://api.exemplo",
      "tok",
    );
    assert.strictEqual(chamado, 0);
  });

  await test("com flag — chama handler uma vez", async () => {
    let chamado = 0;
    let ctx = null;
    configSync.setOnUpdateRequested(async (c) => {
      chamado++;
      ctx = c;
    });
    await configSync.processarPedidoUpdateCloud(
      { aplicarUpdateQuandoOcioso: true },
      "https://api.exemplo",
      "tok",
    );
    assert.strictEqual(chamado, 1);
    assert.strictEqual(ctx.backendUrl, "https://api.exemplo");
    assert.strictEqual(ctx.backendToken, "tok");
  });

  await test("sem handler registrado — não lança", async () => {
    configSync.setOnUpdateRequested(null);
    await configSync.processarPedidoUpdateCloud(
      { aplicarUpdateQuandoOcioso: true },
      "https://api.exemplo",
      "tok",
    );
  });

  configSync.setOnUpdateRequested(null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main();
