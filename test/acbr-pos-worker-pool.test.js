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
    assert.ok(err.printTimedOut === true);
    // Rejeição imediata: terminate pode completar depois; não pode travar o await
    assert.ok(terminated, "terminate deveria ter sido chamado");
    // cooldown
    await new Promise((r) => setTimeout(r, 40));
  });

  await test("timeout rejeita sem esperar terminate lento", async () => {
    process.env.ACBR_POS_WORKER_TERMINATE_MS = "50";
    let termStarted = 0;
    mockWorkerImpl = (w) => {
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
        }
      };
      w.terminate = () =>
        new Promise((resolve) => {
          termStarted = Date.now();
          setTimeout(resolve, 5000); // simula FFI travado
        });
    };

    const t0 = Date.now();
    let err;
    try {
      await pool.imprimirTags({
        printerKey: "RAW:SLOWTERM",
        dllPath: "/tmp/fake.dll",
        iniPath: "/tmp/fake.ini",
        agentRoot: path.join(__dirname, ".."),
        values: { PosPrinter: { Porta: "RAW:SLOWTERM", Modelo: "1" } },
        tags: "</zera>",
        timeoutMs: 60,
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;
    assert.ok(err, "deveria rejeitar");
    assert.strictEqual(err.code, "ACBR_POS_WORKER_KILLED");
    assert.ok(elapsed < 400, `rejeição deve ser rápida, levou ${elapsed}ms`);
    assert.ok(termStarted > 0, "terminate deve ter iniciado em background");
    await new Promise((r) => setTimeout(r, 80));
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

  await test("kill latch impede spawn durante terminate", async () => {
    pool.resetForTests();
    process.env.ACBR_POS_WORKER = "true";
    process.env.ACBR_POS_WORKER_KILL_COOLDOWN_MS = "50";
    process.env.ACBR_POS_CALL_TIMEOUT_MS = "40";
    let spawnCount = 0;
    let terminateStarted = 0;
    let spawnDuringTerminate = false;
    mockWorkerImpl = (w) => {
      spawnCount += 1;
      const h = [...pool._handles.values()][0];
      if (h?.killing && spawnCount > 1) spawnDuringTerminate = true;
      w._onPost = (msg) => {
        if (msg.cmd === "init") {
          w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
          return;
        }
        // hang
      };
      const origTerm = w.terminate.bind(w);
      w.terminate = async () => {
        terminateStarted += 1;
        await new Promise((r) => setTimeout(r, 80));
        return origTerm();
      };
    };

    let err;
    try {
      await pool.imprimirTags({
        printerKey: "RAW:LATCH",
        dllPath: "/tmp/fake.dll",
        iniPath: "/tmp/x.ini",
        agentRoot: path.join(__dirname, ".."),
        values: { PosPrinter: { Porta: "RAW:LATCH" } },
        tags: "x",
        timeoutMs: 40,
      });
    } catch (e) {
      err = e;
    }
    assert.strictEqual(err?.code, "ACBR_POS_WORKER_KILLED");

    // Segunda impressão na fila — deve esperar latch (não spawn mid-terminate)
    mockWorkerImpl = (w) => {
      spawnCount += 1;
      const h = [...pool._handles.values()][0];
      if (h?.killing) spawnDuringTerminate = true;
      w._onPost = (msg) => {
        w.emit("message", { id: msg.id, generation: w.generation, ok: true, data: {} });
      };
    };
    // Circuito pode estar aberto; força worker ainda enabled
    try {
      require("../print/acbrPosPrinterRuntime").resetAcbrPosCircuit();
    } catch (_) {}
    await pool.imprimirTags({
      printerKey: "RAW:LATCH",
      dllPath: "/tmp/fake.dll",
      iniPath: "/tmp/x.ini",
      agentRoot: path.join(__dirname, ".."),
      values: { PosPrinter: { Porta: "RAW:LATCH" } },
      tags: "y",
      timeoutMs: 500,
    }).catch(() => {});
    assert.ok(terminateStarted >= 1);
    assert.strictEqual(spawnDuringTerminate, false, "não deve spawnar com killing ativo");
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
