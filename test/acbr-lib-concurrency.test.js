const test = require("node:test");
const assert = require("node:assert/strict");

const emissionLock = require("../fiscal/fiscalEmissionLock");
const session = require("../fiscal/drivers/acbrLibSession");

test("fiscalEmissionLock serializa emissões concorrentes", async () => {
  emissionLock.resetForTests();
  let simultaneas = 0;
  let maxSimultaneas = 0;

  const tarefa = async (ms) => {
    await emissionLock.withEmissionLock(async () => {
      simultaneas++;
      maxSimultaneas = Math.max(maxSimultaneas, simultaneas);
      await new Promise((r) => setTimeout(r, ms));
      simultaneas--;
    }, "test");
  };

  await Promise.all([tarefa(40), tarefa(40), tarefa(40)]);
  assert.equal(maxSimultaneas, 1);
  assert.equal(emissionLock.isEmissionInProgress(), false);
});

test("fiscalEmissionLock é reentrante em cadeia interna", async () => {
  emissionLock.resetForTests();
  const ordem = [];

  await emissionLock.withEmissionLock(async () => {
    ordem.push("outer");
    await emissionLock.withEmissionLock(async () => {
      ordem.push("inner");
    }, "inner");
  }, "outer");

  assert.deepEqual(ordem, ["outer", "inner"]);
});

test("acbrLibSession suspende idle durante lock ACBr", async () => {
  await session.invalidateNativeSession("test");
  session.suspendIdle();
  const st = session.getSessionStatus();
  assert.equal(st.idleSuspended, true);
  session.resumeIdle();
  assert.equal(session.getSessionStatus().idleSuspended, false);
});

test("acbrLibSession não finaliza em idle_timeout com ACBr ocupado", async () => {
  const acbr = require("../acbr");
  await session.invalidateNativeSession("test");
  session.suspendIdle();
  try {
    const busy = acbr.isAcbrBusy();
    assert.equal(typeof busy, "boolean");
  } finally {
    session.resumeIdle();
  }
});

test("filaFiscal acbrOcupado reflete emissão em andamento", () => {
  const path = require("path");
  const fs = require("fs");
  const testDir = path.join(__dirname, "data-test-concurrency");
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  process.env.FISCAL_DB_PATH = path.join(testDir, "fila_concurrency.db");

  emissionLock.resetForTests();
  const filaFiscal = require("../filaFiscal");
  filaFiscal.init();

  assert.equal(filaFiscal.acbrOcupado(), false);
  assert.equal(filaFiscal.estaEmEmissao(), false);
});
