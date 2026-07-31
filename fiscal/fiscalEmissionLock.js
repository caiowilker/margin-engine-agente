/**
 * Mutex de emissão fiscal — garante no máximo uma emissão (NFC-e/NF-e/EPEC) por vez.
 * Reentrante apenas no mesmo contexto assíncrono (AsyncLocalStorage), para cadeias
 * internas (ex.: EPEC → acbr.emitirNfce). Chamadas externas concorrentes sempre serializam.
 */
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
let emissionLock = Promise.resolve();
let emissionDepth = 0;
let emissionLabel = null;

function isEmissionInProgress() {
  return emissionDepth > 0;
}

function currentEmissionLabel() {
  return emissionLabel;
}

async function withEmissionLock(fn, label = "emissao") {
  const store = als.getStore();
  if (store?.locked) {
    return fn();
  }
  const run = emissionLock.then(async () =>
    als.run({ locked: true }, async () => {
      emissionDepth++;
      emissionLabel = label;
      try {
        return await fn();
      } finally {
        emissionDepth--;
        if (emissionDepth === 0) emissionLabel = null;
      }
    }),
  );
  emissionLock = run.catch(() => {});
  return run;
}

function resetForTests() {
  emissionLock = Promise.resolve();
  emissionDepth = 0;
  emissionLabel = null;
}

module.exports = {
  withEmissionLock,
  isEmissionInProgress,
  currentEmissionLabel,
  resetForTests,
};
