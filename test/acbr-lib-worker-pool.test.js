const test = require("node:test");
const assert = require("node:assert/strict");

test("worker fiscal isola erro sem encerrar processo principal", async () => {
  const pool = require("../fiscal/acbrLibWorkerPool");
  try {
    await assert.rejects(
      () => pool.call("__metodo_invalido__", [], { timeoutMs: 5000 }),
      (error) => error.code === "ACBR_LIB_WORKER_UNKNOWN_METHOD",
    );
    assert.equal(pool.status().online, true);
  } finally {
    pool.terminate("test");
  }
});
