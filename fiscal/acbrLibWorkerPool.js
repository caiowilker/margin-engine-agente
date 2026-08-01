/**
 * Supervisor do processo fiscal ACBrLib.
 *
 * Koffi, DLLs ACBr e process.chdir vivem somente no filho. Um crash/void**
 * reinicia o filho, nunca o processo HTTP que atende localhost:9100.
 */
const { fork, spawn } = require("child_process");
const path = require("path");
const log = require("../logger").child({ modulo: "acbr_lib_worker_pool" });

const WORKER_SCRIPT = path.join(__dirname, "workers", "acbrLibWorker.js");
let child = null;
let generation = 0;
let sequence = 0;
let starting = null;
let killing = null;
let bootWaiter = null;
let lastRestartReason = null;
const pending = new Map();

function enabled() {
  return String(process.env.ACBR_LIB_WORKER || "true").toLowerCase() !== "false";
}

function timeoutMs() {
  const n = parseInt(process.env.ACBR_LIB_WORKER_CALL_TIMEOUT_MS || "180000", 10);
  return Math.max(5_000, Number.isFinite(n) ? n : 180_000);
}

function killCooldownMs() {
  const n = parseInt(process.env.ACBR_LIB_WORKER_KILL_COOLDOWN_MS || "1000", 10);
  return Math.max(0, Number.isFinite(n) ? n : 1000);
}

function killHardMs() {
  const n = parseInt(process.env.ACBR_LIB_WORKER_TERMINATE_MS || "3000", 10);
  return Math.max(500, Number.isFinite(n) ? n : 3000);
}

function workerError(message, code = "ACBR_LIB_WORKER_UNAVAILABLE", meta = {}) {
  const error = new Error(message);
  error.code = code;
  error.workerIsolated = true;
  Object.assign(error, meta);
  return error;
}

function rejectAll(error) {
  for (const pendingCall of pending.values()) {
    clearTimeout(pendingCall.timer);
    pendingCall.reject(error);
  }
  pending.clear();
}

async function stopProcess(current) {
  if (!current?.pid) return;
  const startedAt = Date.now();
  try {
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const p = spawn("taskkill", ["/pid", String(current.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        p.once("error", resolve);
        p.once("exit", resolve);
      });
    } else {
      current.kill("SIGKILL");
    }
  } catch (_) {}
  log.warn(
    {
      pid: current.pid,
      reason: lastRestartReason,
      durationMs: Date.now() - startedAt,
      terminateHardMs: killHardMs(),
      metric: "acbrlib.worker_kill",
    },
    "[ACBrLibWorker] término solicitado",
  );
}

async function terminate(reason = "shutdown") {
  if (killing) return killing;
  const current = child;
  child = null;
  generation += 1;
  lastRestartReason = reason;
  rejectAll(
    workerError(`Worker fiscal encerrado: ${reason}`, "ACBR_LIB_WORKER_EXIT", {
      restartReason: reason,
    }),
  );
  killing = (async () => {
    await Promise.race([
      stopProcess(current),
      new Promise((resolve) => setTimeout(resolve, killHardMs())),
    ]);
    const cooldown = killCooldownMs();
    if (cooldown) await new Promise((resolve) => setTimeout(resolve, cooldown));
  })().finally(() => {
    killing = null;
  });
  return killing;
}

function attach() {
  const currentGeneration = ++generation;
  const spawned = fork(WORKER_SCRIPT, [], {
    env: {
      ...process.env,
      ACBR_LIB_WORKER_CHILD: "true",
      // O pai é o único responsável por matar/respawnar o filho.
      ACBR_LIB_AUTO_RECYCLE: "false",
      ACBR_LIB_WORKER_GENERATION: String(currentGeneration),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child = spawned;
  bootWaiter = {};
  bootWaiter.promise = new Promise((resolve, reject) => {
    bootWaiter.resolve = resolve;
    bootWaiter.reject = reject;
    bootWaiter.timer = setTimeout(() => reject(workerError("Timeout de boot do worker fiscal")), 10_000);
  });

  spawned.on("message", (message) => {
    if (message?.generation !== currentGeneration) return;
    if (message?.id == null) {
      if (message.ok && bootWaiter?.resolve) {
        clearTimeout(bootWaiter.timer);
        bootWaiter.resolve(spawned);
        bootWaiter = null;
      }
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(message.id);
    if (message.ok) return call.resolve(message.data);
    const error = workerError(
      message.error?.message || "Falha no worker fiscal",
      message.error?.code || "ACBR_LIB_WORKER_ERROR",
      { ...(message.error?.meta || {}) },
    );
    call.reject(error);
    if (error.processPoisoned || error.code === "ACBR_LIB_KOFFI_POISONED") {
      void terminate("koffi_poison");
    }
  });
  spawned.on("error", (error) => {
    log.error({ err: error.message }, "[ACBrLibWorker] erro no processo filho");
  });
  spawned.on("exit", (code, signal) => {
    if (child === spawned) child = null;
    if (bootWaiter?.reject) {
      clearTimeout(bootWaiter.timer);
      bootWaiter.reject(workerError(`Worker fiscal encerrou no boot: ${code}`));
      bootWaiter = null;
    }
    generation += 1;
    rejectAll(
      workerError(
        `Worker fiscal finalizou (code=${code}, signal=${signal || "none"})`,
        "ACBR_LIB_WORKER_EXIT",
      ),
    );
    log.warn(
      { code, signal, metric: "acbrlib.worker_exit" },
      "[ACBrLibWorker] processo fiscal finalizado; será recriado sob demanda",
    );
  });
  return spawned;
}

async function ensure() {
  if (child?.connected && !killing) return child;
  if (killing) await killing;
  if (starting) return starting;
  starting = Promise.resolve()
    .then(() => {
      attach();
      return bootWaiter.promise;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function call(method, args = [], opts = {}) {
  if (!enabled()) {
    throw workerError("Worker ACBrLib desabilitado", "ACBR_LIB_WORKER_DISABLED");
  }
  const worker = await ensure();
  const id = ++sequence;
  const timeout = opts.timeoutMs || timeoutMs();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = workerError(
        `Timeout no worker fiscal (${timeout}ms): ${method}`,
        "ACBR_LIB_WORKER_TIMEOUT",
      );
      reject(error);
      void terminate("timeout");
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      worker.send({ id, generation, method, args });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
      void terminate("send_error");
    }
  });
}

function status() {
  return {
    enabled: enabled(),
    online: !!child?.connected,
    generation,
    pending: pending.size,
    restarting: !!killing,
    lastRestartReason,
  };
}

module.exports = { enabled, call, terminate, status, _resetForTests: () => terminate("test") };
