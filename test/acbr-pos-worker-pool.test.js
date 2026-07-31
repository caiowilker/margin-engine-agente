#!/usr/bin/env node
/**
 * Pool PosPrinter — mock Worker: timeout → terminate, late message ignorada, fallback.
 */
const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");
const path = require("path");

const origLoad = Module._load;
let mockWorkerImpl = null;

class MockWorker extends EventEmitter {
  constructor(script, opts) {
    super();
    this.script = script;
    this.opts = opts;
    this.terminated = false;
    this.generation = opts?.workerData?.generation ?? 0;
    if (typeof mockWorkerImpl === "function") {
      mockWorkerImpl(this);
    } else {
      setImmediate(() => this.emit("message", { id: null, generation: this.generation, ok: true, data: { boot: true } }));
    }
  }
  postMessage(msg) {
    if (this.terminated) return;
    if (typeof this._onPost === "function") this._onPost(msg);
  }
  async terminate() {
    this.terminated = true;
    this.emit("exit", 1);
  }
}

Module._load = function (request, parent, isMain) {
  if (request === "worker_threads") {
    return { Worker: MockWorker, parentPort: null, workerData: {} };
  }
  return origLoad.apply(this, arguments);
};

// Carrega pool DEPOIS do mock
delete require.cache[require.resolve("../print/acbrPosWorkerPool")];
const pool = require("../print/acbrPosWorkerPool");

async function test(name, fn) {
  pool.resetForTests();
  mockWorkerImpl = null;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}:`, e.message);
    throw e;
  }
}

async function run() {
  process.env.ACBR_POS_WORKER = "true";
  process.env.ACBR_POS_WORKER_KILL_COOLDOWN_MS = "20";
  process.env.ACBR_POS_CALL_TIMEOUT_MS = "80";
  process.env.LOG_SILENT = "true";
  const fs = require("fs");
  const os = require("os");
  const circuitTmp = path.join(os.tmpdir(), `acbr-circuit-worker-test-${Date.now()}.json`);
  process.env.ACBR_POS_CIRCUIT_FILE = circuitTmp;

  await test("timeout chama terminate e rejeita ACBR_POS_WORKER_KILLED", async () => {
    let terminated = false;
    mockWorkerImpl = (w) => {
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
          return;
        }
        // imprimirTags: nunca responde → timeout
      };
      const origTerm = w.terminate.bind(w);
      w.terminate = async () => {
        terminated = true;
        return origTerm();
      };
    };

    let err;
    try {
      await pool.imprimirTags({
        printerKey: "RAW:TEST",
        dllPath: "/tmp/fake.dll",
        iniPath: "/tmp/fake.ini",
        agentRoot: path.join(__dirname, ".."),
        values: { PosPrinter: { Porta: "RAW:TEST", Modelo: "1" } },
        tags: "</zera>",
        timeoutMs: 80,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "deveria rejeitar");
    assert.strictEqual(err.code, "ACBR_POS_WORKER_KILLED");
    assert.ok(terminated, "terminate deveria ter sido chamado");
    // cooldown
    await new Promise((r) => setTimeout(r, 40));
  });

  await test("late message de geração antiga é ignorada", async () => {
    mockWorkerImpl = (w) => {
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
          return;
        }
        // Responde com generation errada — deve ser ignorada; timeout mata
        setTimeout(() => {
          w.emit("message", {
            id: msg.id,
            generation: w.generation - 1,
            ok: true,
            data: { late: true },
          });
        }, 10);
      };
    };

    let err;
    try {
      await pool.imprimirTags({
        printerKey: "RAW:LATE",
        dllPath: "/tmp/fake.dll",
        iniPath: "/tmp/fake.ini",
        agentRoot: path.join(__dirname, ".."),
        values: { PosPrinter: { Porta: "RAW:LATE" } },
        tags: "x",
        timeoutMs: 60,
      });
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err?.code, "ACBR_POS_WORKER_KILLED");
  });

  await test("spawn/init fail marca fallback in-process", async () => {
    mockWorkerImpl = (w) => {
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", {
            id: msg.id,
            generation: w.generation,
            ok: false,
            error: { code: "ACBR_POS_DLL_MISSING", message: "no dll" },
          });
        }
      };
    };

    let err;
    try {
      await pool.imprimirTags({
        printerKey: "RAW:FALLBACK",
        dllPath: "/tmp/missing.dll",
        iniPath: "/tmp/x.ini",
        agentRoot: path.join(__dirname, ".."),
        values: {},
        tags: "x",
        timeoutMs: 200,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.strictEqual(pool.isPosWorkerEnabled(), false);
  });

  await test("ACBR_POS_WORKER=false desliga pool", async () => {
    pool.resetForTests();
    process.env.ACBR_POS_WORKER = "false";
    assert.strictEqual(pool.isPosWorkerEnabled(), false);
    process.env.ACBR_POS_WORKER = "true";
  });

  await test("fila interna serializa duas impressões (sem BUSY)", async () => {
    pool.resetForTests();
    process.env.ACBR_POS_WORKER = "true";
    const order = [];
    mockWorkerImpl = (w) => {
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
          return;
        }
        if (msg.cmd === "imprimirTags") {
          order.push(`start-${msg.tags}`);
          setTimeout(() => {
            order.push(`end-${msg.tags}`);
            w.emit("message", {
              id: msg.id,
              generation: w.generation,
              ok: true,
              data: {},
            });
          }, 40);
        }
      };
    };
    const a = pool.imprimirTags({
      printerKey: "RAW:Q",
      dllPath: "/tmp/fake.dll",
      iniPath: "/tmp/x.ini",
      agentRoot: path.join(__dirname, ".."),
      values: {},
      tags: "A",
      timeoutMs: 500,
    });
    const b = pool.imprimirTags({
      printerKey: "RAW:Q",
      dllPath: "/tmp/fake.dll",
      iniPath: "/tmp/x.ini",
      agentRoot: path.join(__dirname, ".."),
      values: {},
      tags: "B",
      timeoutMs: 500,
    });
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ["start-A", "end-A", "start-B", "end-B"]);
  });

  await test("clearFallbackInProcess reabilita worker após Detectar", async () => {
    pool.resetForTests();
    process.env.ACBR_POS_WORKER = "true";
    pool.markFallbackInProcess("test");
    assert.strictEqual(pool.isPosWorkerEnabled(), false);
    assert.strictEqual(pool.clearFallbackInProcess(), true);
    assert.strictEqual(pool.isPosWorkerEnabled(), true);
  });

  // Restore module loader + limpa cache do mock (evita contaminar suite print)
  Module._load = origLoad;
  try {
    delete require.cache[require.resolve("worker_threads")];
  } catch (_) {}
  delete require.cache[require.resolve("../print/acbrPosWorkerPool")];
  try {
    delete require.cache[require.resolve("../print/acbrPosPrinterRuntime")];
  } catch (_) {}
  pool.resetForTests();
  try {
    if (fs.existsSync(circuitTmp)) fs.unlinkSync(circuitTmp);
  } catch (_) {}
  delete process.env.ACBR_POS_CIRCUIT_FILE;
  console.log("acbr-pos-worker-pool.test.js OK");
}

run().catch((e) => {
  Module._load = origLoad;
  console.error(e);
  process.exit(1);
});
