/**
 * Pool de workers PosPrinter — 1 worker por printerKey.
 * Timeout → worker.terminate() + cooldown + circuito + generation bump.
 * Spawn/init fail → fallback in-process (não derruba o serviço).
 * Chamadas serializadas por key (fila interna) — nunca BUSY throw.
 */
const { Worker } = require("worker_threads");
const path = require("path");
const log = require("../logger").child({ modulo: "acbr_pos_worker_pool" });

const WORKER_SCRIPT = path.join(__dirname, "workers", "acbrPosWorker.js");

/** @type {Map<string, WorkerHandle>} */
const handles = new Map();
let forceInProcess = false;
let reqSeq = 0;

/**
 * @typedef {{
 *   worker: Worker|null,
 *   generation: number,
 *   queue: Promise<unknown>,
 *   pending: Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>,
 *   printerKey: string,
 *   killing: Promise<void>|null,
 * }} WorkerHandle
 */

function isPosWorkerEnabled() {
  if (forceInProcess) return false;
  const v = String(process.env.ACBR_POS_WORKER || "true").toLowerCase();
  if (v === "false" || v === "0") return false;
  return true;
}

function hasActiveWorker() {
  for (const h of handles.values()) {
    if (h.worker) return true;
  }
  return false;
}

function markFallbackInProcess(reason) {
  if (forceInProcess) return;
  forceInProcess = true;
  const reasonShort = String(reason || "").slice(0, 240);
  log.error(
    {
      reason: reasonShort,
      metric: "print.worker_fallback_inprocess",
      severity: "high",
      note:
        "FFI koffi no main/threadpool — risco de pressionar HTTP; circuito ACBr aberto para comerciais via native",
    },
    "[AcbrPosWorker] Fallback in-process — worker indisponível (P2c)",
  );
  // P2c: preferir native nos próximos comerciais em vez de koffi no processo principal
  try {
    const runtime = require("./acbrPosPrinterRuntime");
    if (typeof runtime.openAcbrPosCircuit === "function") {
      runtime.openAcbrPosCircuit(
        `worker_fallback_inprocess: ${reasonShort || "spawn_fail"}`,
      );
    }
  } catch (_) {
    /* ignore circular/boot */
  }
}

/** Operador Detectar/force: permite tentar worker de novo após falha de spawn. */
function clearFallbackInProcess() {
  if (!forceInProcess) return false;
  forceInProcess = false;
  log.info(
    { metric: "print.worker_fallback_cleared" },
    "[AcbrPosWorker] Fallback in-process limpo — worker habilitado novamente",
  );
  return true;
}

function killCooldownMs() {
  const n = parseInt(process.env.ACBR_POS_WORKER_KILL_COOLDOWN_MS || "750", 10);
  return Number.isFinite(n) && n >= 0 ? n : 750;
}

function defaultCallTimeoutMs() {
  const n = parseInt(process.env.ACBR_POS_CALL_TIMEOUT_MS || "4500", 10);
  return Math.max(1000, Number.isFinite(n) ? n : 5000);
}

function getHandle(printerKey) {
  const key = String(printerKey || "default");
  let h = handles.get(key);
  if (!h) {
    h = {
      worker: null,
      generation: 0,
      queue: Promise.resolve(),
      pending: new Map(),
      printerKey: key,
      killing: null,
    };
    handles.set(key, h);
  }
  return h;
}

function rejectAll(h, err) {
  for (const [, p] of h.pending) {
    clearTimeout(p.timer);
    try {
      p.reject(err);
    } catch (_) {}
  }
  h.pending.clear();
}

function attachWorker(h, workerData) {
  const worker = new Worker(WORKER_SCRIPT, {
    workerData: {
      ...workerData,
      generation: h.generation,
    },
  });
  h.worker = worker;

  worker.on("message", (msg) => {
    if (msg?.generation != null && Number(msg.generation) !== h.generation) {
      return; // late message
    }
    if (msg?.id == null) return; // boot ping
    const pending = h.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    h.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.data || {});
    else {
      const e = new Error(msg.error?.message || "ACBr PosPrinter worker error");
      e.code = msg.error?.code || "ACBR_POS_WORKER_ERROR";
      if (msg.error?.acbrRet != null) e.acbrRet = msg.error.acbrRet;
      if (msg.error?.acbrPhase) e.acbrPhase = msg.error.acbrPhase;
      else if (pending.cmd === "imprimirTags") e.acbrPhase = "imprimir";
      else if (pending.cmd === "init") e.acbrPhase = "init";
      pending.reject(e);
    }
  });

  worker.on("error", (err) => {
    log.error({ err: err.message, key: h.printerKey }, "[AcbrPosWorker] worker error");
    const e = new Error(err.message || "worker error");
    e.code = "ACBR_POS_WORKER_ERROR";
    e.printTimedOut = false;
    killAndRespawn(h, e).catch(() => {});
  });

  worker.on("exit", (code) => {
    if (h.worker === worker) h.worker = null;
    if (h.pending.size) {
      const e = new Error(`PosPrinter worker exit code=${code}`);
      e.code = "ACBR_POS_WORKER_EXIT";
      rejectAll(h, e);
    }
  });

  return worker;
}

async function ensureWorker(h, workerData) {
  // Latch pós-timeout: NÃO spawnar 2ª DLL enquanto terminate() ainda drena o RAW.
  while (h.killing) {
    await h.killing.catch(() => {});
  }
  if (h.worker) return h.worker;
  try {
    const w = attachWorker(h, workerData);
    await callRaw(h, "init", { values: workerData.values }, defaultCallTimeoutMs());
    return w;
  } catch (err) {
    await terminateQuiet(h);
    markFallbackInProcess(err.message);
    throw err;
  }
}

function callRaw(h, cmd, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!h.worker) {
      const e = new Error("PosPrinter worker ausente");
      e.code = "ACBR_POS_WORKER_GONE";
      return reject(e);
    }
    const id = ++reqSeq;
    const timer = setTimeout(() => {
      h.pending.delete(id);
      const e = new Error(
        `Timeout ACBr PosPrinter worker (${timeoutMs}ms) cmd=${cmd}`,
      );
      e.code = "ACBR_POS_WORKER_KILLED";
      e.printTimedOut = true;
      // init = pré-impressão; imprimirTags = já pode ter ido ao spooler (anti-dupla).
      e.acbrPhase =
        cmd === "imprimirTags" ? "imprimir" : cmd === "init" ? "init" : "idle";
      // Rejeita na hora (não prende o job), mas ARMA o latch de kill
      // sincronicamente para o próximo enqueue NÃO spawnar 2ª DLL no RAW.
      const killP = killAndRespawn(h, e);
      reject(e);
      void killP;
    }, timeoutMs);

    h.pending.set(id, { resolve, reject, timer, cmd });
    try {
      h.worker.postMessage({
        id,
        generation: h.generation,
        cmd,
        ...payload,
      });
    } catch (err) {
      clearTimeout(timer);
      h.pending.delete(id);
      reject(err);
    }
  });
}

const TERMINATE_HARD_MS = Math.max(
  500,
  parseInt(process.env.ACBR_POS_WORKER_TERMINATE_MS || "2000", 10) || 2000,
);

async function terminateQuiet(h) {
  const w = h.worker;
  h.worker = null;
  h.generation += 1;
  rejectAll(
    h,
    Object.assign(new Error("worker terminated"), {
      code: "ACBR_POS_WORKER_KILLED",
      printTimedOut: true,
    }),
  );
  if (!w) return;
  const t0 = Date.now();
  try {
    await Promise.race([
      w.terminate().catch(() => {}),
      new Promise((r) => setTimeout(r, TERMINATE_HARD_MS)),
    ]);
  } catch (_) {}
  const durationMs = Date.now() - t0;
  log.warn(
    {
      key: h.printerKey,
      generation: h.generation,
      durationMs,
      terminateHardMs: TERMINATE_HARD_MS,
      metric: "print.worker_kill",
      note:
        durationMs >= TERMINATE_HARD_MS
          ? "terminate() atingiu teto — worker pode ainda existir até o OS liberar"
          : undefined,
    },
    "[AcbrPosWorker] terminate()",
  );
}

async function killAndRespawn(h, cause) {
  if (h.killing) return h.killing;
  // Armar latch ANTES de qualquer await — próximo ensureWorker espera.
  let releaseLatch = () => {};
  h.killing = new Promise((resolve) => {
    releaseLatch = resolve;
  });
  try {
    await terminateQuiet(h);
    // Circuito só em falha de sessão/init — timeout mid-print não abandona ACBr forever.
    try {
      const runtime = require("./acbrPosPrinterRuntime");
      if (runtime.shouldOpenCircuitFromError?.(cause)) {
        runtime.openAcbrPosCircuit(cause?.message || "ACBR_POS_WORKER_KILLED");
      }
    } catch (_) {}
    try {
      require("./factory").resetPrintProvider();
    } catch (_) {}
    const cool = killCooldownMs();
    if (cool > 0) await new Promise((r) => setTimeout(r, cool));
    log.info(
      { key: h.printerKey, cooldownMs: cool, metric: "print.worker_respawn" },
      "[AcbrPosWorker] cooldown pós-kill concluído",
    );
  } finally {
    h.killing = null;
    releaseLatch();
  }
}

/** Serializa operações por printerKey (substitui busy throw). */
function enqueue(h, fn) {
  const run = h.queue.then(() => fn());
  h.queue = run.catch(() => {});
  return run;
}

/**
 * @param {object} opts
 */
async function imprimirTags(opts) {
  if (!isPosWorkerEnabled()) {
    const e = new Error("ACBR_POS_WORKER disabled");
    e.code = "ACBR_POS_WORKER_DISABLED";
    throw e;
  }
  const h = getHandle(opts.printerKey);
  const t0 = Date.now();
  return enqueue(h, async () => {
    await ensureWorker(h, {
      dllPath: opts.dllPath,
      iniPath: opts.iniPath,
      agentRoot: opts.agentRoot,
      cryptKey: opts.cryptKey || "",
      values: opts.values,
    });
    const data = await callRaw(
      h,
      "imprimirTags",
      { tags: opts.tags, values: opts.values },
      opts.timeoutMs || defaultCallTimeoutMs(),
    );
    log.info(
      {
        key: opts.printerKey,
        durationMs: Date.now() - t0,
        metric: "print.worker_ok",
      },
      "[AcbrPosWorker] imprimirTags ok",
    );
    return { ok: true, native: true, worker: true, ...data };
  });
}

async function abrirGaveta(opts) {
  if (!isPosWorkerEnabled()) {
    const e = new Error("ACBR_POS_WORKER disabled");
    e.code = "ACBR_POS_WORKER_DISABLED";
    throw e;
  }
  const h = getHandle(opts.printerKey);
  return enqueue(h, async () => {
    await ensureWorker(h, {
      dllPath: opts.dllPath,
      iniPath: opts.iniPath,
      agentRoot: opts.agentRoot,
      cryptKey: opts.cryptKey || "",
      values: opts.values,
    });
    const data = await callRaw(
      h,
      "abrirGaveta",
      { values: opts.values },
      opts.timeoutMs || defaultCallTimeoutMs(),
    );
    return { ok: true, native: true, worker: true, ...data };
  });
}

async function invalidateAll() {
  for (const h of handles.values()) {
    try {
      if (h.worker) {
        await callRaw(h, "shutdown", {}, 1500).catch(() => {});
      }
    } catch (_) {}
    await terminateQuiet(h);
  }
}

function resetForTests() {
  forceInProcess = false;
  for (const h of handles.values()) {
    if (h.worker) {
      try {
        h.worker.terminate();
      } catch (_) {}
    }
  }
  handles.clear();
  reqSeq = 0;
}

module.exports = {
  isPosWorkerEnabled,
  hasActiveWorker,
  imprimirTags,
  abrirGaveta,
  invalidateAll,
  markFallbackInProcess,
  clearFallbackInProcess,
  resetForTests,
  /** @internal */
  _handles: handles,
};
