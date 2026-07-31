#!/usr/bin/env node
/** Worker owns session — main não abre PosPrinter in-process */
const assert = require("assert");

process.env.ACBR_POS_WORKER = "true";
process.env.LOG_SILENT = "true";

const runtime = require("../print/acbrPosPrinterRuntime");
const pool = require("../print/acbrPosWorkerPool");

async function run() {
  pool.resetForTests();
  assert.strictEqual(pool.isPosWorkerEnabled(), true);

  let threw = false;
  try {
    await runtime.withPosPrinterSession(async () => "nope");
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, "ACBR_POS_WORKER_OWNS_SESSION");
  }
  assert.ok(threw, "deveria bloquear sessão in-process");

  const st = await runtime.lerStatusFormatadoNative(1);
  assert.strictEqual(st.workerOwned, true);
  assert.strictEqual(st.ok, true);

  const ver = await runtime.lerVersaoNative();
  assert.strictEqual(ver.workerOwned, true);

  // fromWorkerFallback: guarda não aplica (pode falhar por DLL ausente — OK)
  try {
    await runtime.withPosPrinterSession(async () => ({ ok: true }), {
      fromWorkerFallback: true,
    });
  } catch (e) {
    assert.notStrictEqual(e.code, "ACBR_POS_WORKER_OWNS_SESSION");
  }

  pool.resetForTests();
  console.log("worker-owns-session.test.js OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
