/**
 * NamedMutex por recurso físico (USB hub / spooler).
 * Reentrante (como fiscalEmissionLock): nested run na mesma key não espera.
 * Ordem obrigatória entre keys diferentes: physicalLock → emissionLock / printLock interno.
 */
const log = require("../logger").child({ modulo: "physical_resource_lock" });

/** @type {Map<string, { tail: Promise<unknown>, depth: number, label: string|null }>} */
const locks = new Map();

function getEntry(key) {
  const k = String(key || "default");
  let entry = locks.get(k);
  if (!entry) {
    entry = { tail: Promise.resolve(), depth: 0, label: null };
    locks.set(k, entry);
  }
  return entry;
}

function isHeld(key) {
  return getEntry(key).depth > 0;
}

function currentLabel(key) {
  return getEntry(key).label;
}

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>|T} fn
 * @param {string} [label]
 * @param {{ waitMs?: number }} [opts] — se a espera na fila exceder waitMs, falha sem rodar fn
 * @returns {Promise<T>}
 */
async function run(key, fn, label = "physical", opts = {}) {
  const entry = getEntry(key);
  // Reentrante: PosPrinter → fallback native no mesmo USB não pode deadlock
  if (entry.depth > 0) {
    return fn();
  }
  const waitMs =
    opts && Number.isFinite(opts.waitMs) && opts.waitMs > 0
      ? Math.floor(opts.waitMs)
      : 0;
  const tEnter = Date.now();
  const runPromise = entry.tail.then(async () => {
    const waitedMs = Date.now() - tEnter;
    if (waitMs > 0 && waitedMs > waitMs) {
      const err = new Error(
        `Timeout aguardando recurso físico "${key}" (${waitMs}ms; esperou ${waitedMs}ms)`,
      );
      err.code = "PHYSICAL_LOCK_WAIT_TIMEOUT";
      err.printTimedOut = true;
      log.warn(
        {
          key,
          label,
          waitedMs,
          waitMs,
          metric: "physical_lock.wait_timeout",
        },
        "[PhysicalLock] Espera esgotada — sem segundo envio",
      );
      throw err;
    }
    if (waitedMs > 200) {
      log.info(
        { key, label, waitedMs, metric: "physical_lock.wait" },
        "[PhysicalLock] Esperou recurso físico",
      );
    }
    entry.depth += 1;
    entry.label = label;
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      entry.depth = Math.max(0, entry.depth - 1);
      if (entry.depth === 0) entry.label = null;
      const ms = Date.now() - t0;
      if (ms > 3000) {
        log.warn(
          { key, label, durationMs: ms, metric: "physical_lock.slow" },
          "[PhysicalLock] Operação lenta sob lock",
        );
      }
    }
  });
  entry.tail = runPromise.catch(() => {});
  return runPromise;
}

function resetForTests() {
  locks.clear();
}

module.exports = {
  run,
  isHeld,
  currentLabel,
  resetForTests,
};
