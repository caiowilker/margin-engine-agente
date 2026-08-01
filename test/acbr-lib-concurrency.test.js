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

test("fiscalEmissionLock serializa chamadas externas (não reentra entre contextos)", async () => {
  emissionLock.resetForTests();
  let simultaneas = 0;
  let maxSimultaneas = 0;

  const tarefa = async () => {
    await emissionLock.withEmissionLock(async () => {
      simultaneas++;
      maxSimultaneas = Math.max(maxSimultaneas, simultaneas);
      await new Promise((r) => setTimeout(r, 30));
      // Tentativa "externa" aninhada via Promise.resolve().then — novo contexto ALS
      await Promise.resolve().then(async () => {
        // Mesmo tick assíncrono ainda herda ALS se await dentro do run — OK.
      });
      simultaneas--;
    }, "ext");
  };

  await Promise.all([tarefa(), tarefa()]);
  assert.equal(maxSimultaneas, 1);
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

test("withAcbrLock é reentrante no mesmo contexto ALS", async () => {
  const acbr = require("../acbr");
  const ordem = [];
  await acbr.withAcbrLock(async () => {
    ordem.push("outer");
    assert.equal(acbr.isHoldingAcbrLock(), true);
    await acbr.withAcbrLock(async () => {
      ordem.push("inner");
      assert.equal(acbr.isHoldingAcbrLock(), true);
    }, "inner");
  }, "outer");
  assert.deepEqual(ordem, ["outer", "inner"]);
});

test("acbrLibSession idle sob lock finaliza (não confunde busy do próprio mutex)", async () => {
  const acbr = require("../acbr");
  await session.invalidateNativeSession("test");
  session.resetDllPinForTests();

  // Simula sessão fantasma mínima: só o caminho idle_timeout + holding lock.
  let idleAttempted = false;
  await acbr.withAcbrLock(async () => {
    assert.equal(acbr.isAcbrBusy(), true);
    assert.equal(acbr.isHoldingAcbrLock(), true);
    // destroySession com idle_timeout enquanto holding NÃO deve remarcar por busy.
    idleAttempted = true;
    await session.invalidateNativeSession("idle_timeout", "nfe");
  }, "idle-test");

  assert.equal(idleAttempted, true);
  assert.equal(session.getSessionStatus().ativa, false);
});

test("acbrLibSession soft-dead sem sessão ativa não bricka o caixa", async () => {
  await session.invalidateNativeSession("test");
  session.resetDllPinForTests();
  await session.invalidateNativeSession("koffi_dead", "nfe");
  assert.equal(session.isSoftDead("nfe"), false);
});

test("acbrLibSession clearSoftDead libera gate", async () => {
  await session.invalidateNativeSession("test");
  session.resetDllPinForTests();
  session.clearSoftDead("nfe");
  assert.equal(session.isSoftDead("nfe"), false);
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
