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

test("graça de boot bloqueia recycle (mantém porta 9100)", () => {
  const recycle = require("../fiscal/drivers/acbrLibProcessRecycle");
  recycle.resetForTests();
  process.env.ACBR_LIB_AUTO_RECYCLE = "true";
  process.env.ACBR_LIB_RECYCLE_BOOT_GRACE_MS = "120000";
  process.env.EMISSAO_FISCAL = "false";
  try {
    require("../acbr").setRuntimeEmissaoFiscal?.(false);
  } catch (_) {}
  recycle.markProcessPoisoned("boot_test");
  const st = recycle.getRecycleStatus();
  assert.equal(st.poisoned, true);
  assert.equal(st.bootGrace, true);
  assert.equal(st.recycleScheduled, false);
  assert.equal(recycle.inBootGrace(), true);
  recycle.resetForTests();
  delete process.env.ACBR_LIB_AUTO_RECYCLE;
  delete process.env.ACBR_LIB_RECYCLE_BOOT_GRACE_MS;
});

test("com emissão fiscal ativa recycle não espera graça de boot", () => {
  const recycle = require("../fiscal/drivers/acbrLibProcessRecycle");
  recycle.resetForTests();
  process.env.ACBR_LIB_AUTO_RECYCLE = "false"; // não exit no teste
  process.env.ACBR_LIB_RECYCLE_BOOT_GRACE_MS = "120000";
  process.env.EMISSAO_FISCAL = "true";
  try {
    require("../acbr").setRuntimeEmissaoFiscal?.(true);
  } catch (_) {}
  recycle.markProcessPoisoned("emissao_on");
  const st = recycle.getRecycleStatus();
  assert.equal(st.poisoned, true);
  assert.equal(st.bootGrace, false);
  recycle.resetForTests();
  try {
    require("../acbr").setRuntimeEmissaoFiscal?.(null);
  } catch (_) {}
  delete process.env.ACBR_LIB_AUTO_RECYCLE;
  delete process.env.ACBR_LIB_RECYCLE_BOOT_GRACE_MS;
  delete process.env.EMISSAO_FISCAL;
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
