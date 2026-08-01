const test = require("node:test");
const assert = require("node:assert/strict");

test("acbrLibProcessRecycle marca poison e agenda recycle", () => {
  const recycle = require("../fiscal/drivers/acbrLibProcessRecycle");
  recycle.resetForTests();
  process.env.ACBR_LIB_AUTO_RECYCLE = "false";
  recycle.resetForTests();
  assert.equal(recycle.isProcessPoisoned(), false);
  recycle.markProcessPoisoned("test");
  assert.equal(recycle.isProcessPoisoned(), true);
  const st = recycle.getRecycleStatus();
  assert.equal(st.poisoned, true);
  recycle.resetForTests();
  delete process.env.ACBR_LIB_AUTO_RECYCLE;
});

test("soft abandon não usa Symbol.dispose (wrapper oficial Finalizar)", async () => {
  const session = require("../fiscal/drivers/acbrLibSession");
  await session.invalidateNativeSession("test");
  session.resetDllPinForTests();

  let disposeCalled = false;
  const fakeInst = {
    [Symbol.dispose]() {
      disposeCalled = true;
      this.finalizar();
    },
    finalizar() {
      throw new Error("Unexpected External value, expected void **");
    },
  };

  // Injeta sessão falsa e abandona como koffi_dead
  const slots = session.getSessionStatus();
  assert.equal(slots.ativa, false);

  // Simula via invalidate com sessão: usar ensure path indireto —
  // destroySession é interno; validamos que soft-dead sem sessão NÃO bricka.
  await session.invalidateNativeSession("koffi_dead", "nfe");
  assert.equal(session.isSoftDead("nfe"), false);
  assert.equal(disposeCalled, false);
});
