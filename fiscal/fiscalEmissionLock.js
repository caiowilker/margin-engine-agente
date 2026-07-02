/**
 * Mutex de emissão fiscal — garante no máximo uma emissão (NFC-e/NF-e/EPEC) por vez.
 * Reentrante para cadeias internas (ex.: EPEC paridade → acbr.emitirNfce).
 */
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
  if (emissionDepth > 0) {
    return fn();
  }
  const run = emissionLock.then(async () => {
    emissionDepth++;
    emissionLabel = label;
    try {
      return await fn();
    } finally {
      emissionDepth--;
      if (emissionDepth === 0) emissionLabel = null;
    }
  });
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
