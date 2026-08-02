#!/usr/bin/env node
/**
 * Garante que wrapKoffiFunc respeita o contrato real do koffi:
 * fn.async(...args, callback) — sem callback → "Expected N+1 arguments, got N".
 */
const assert = require("assert");
const { __wrapKoffiFunc } = require("../print/acbrPosPrinterRuntime");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

function makeFakeKoffiFunc(arity) {
  const sync = (...args) => {
    if (args.length !== arity) {
      throw new TypeError(`Expected ${arity} arguments, got ${args.length}`);
    }
    return 0;
  };
  // Espelha koffi: async exige arity + 1 (callback)
  sync.async = (...args) => {
    if (args.length !== arity + 1) {
      throw new TypeError(`Expected ${arity + 1} arguments, got ${args.length}`);
    }
    const cb = args[args.length - 1];
    if (typeof cb !== "function") {
      throw new TypeError("Expected callback function as last argument");
    }
    const callArgs = args.slice(0, -1);
    if (callArgs.length !== arity) {
      throw new TypeError(`Expected ${arity} arguments, got ${callArgs.length}`);
    }
    setImmediate(() => cb(null, 0));
  };
  return sync;
}

async function run() {
  console.log("acbr-posprinter-koffi-wrap.test.js\n");

  await testAsync("callback-style (promisify) — POS_Inicializar arity 2", async () => {
    const wrapped = __wrapKoffiFunc(makeFakeKoffiFunc(2), "POS_Inicializar");
    const ret = await new Promise((resolve, reject) => {
      wrapped.async("ini", "", (err, v) => (err ? reject(err) : resolve(v)));
    });
    assert.strictEqual(ret, 0);
  });

  await testAsync("promise-style sem callback — POS_Imprimir arity 5 (flags int)", async () => {
    const wrapped = __wrapKoffiFunc(makeFakeKoffiFunc(5), "POS_Imprimir");
    const ret = await wrapped.async("tags", 1, 1, 1, 1);
    assert.strictEqual(ret, 0);
  });

  test("sync passa arity correta", () => {
    const wrapped = __wrapKoffiFunc(makeFakeKoffiFunc(3), "POS_ConfigGravarValor");
    assert.strictEqual(wrapped("PosPrinter", "Porta", "RAW:X"), 0);
  });

  await testAsync("regressão: NÃO stripar callback (era Expected 3 got 2)", async () => {
    const wrapped = __wrapKoffiFunc(makeFakeKoffiFunc(2), "POS_Inicializar");
    // Simula o bug antigo: chamar async nativo sem callback
    let threw = false;
    try {
      const native = makeFakeKoffiFunc(2);
      native.async("a", "b"); // sem cb → erro koffi
    } catch (e) {
      threw = /Expected 3 arguments, got 2/.test(e.message);
    }
    assert.ok(threw, "fake koffi deve falhar sem callback");

    // Wrapper corrigido não deve falhar
    const ret = await wrapped.async("a", "b");
    assert.strictEqual(ret, 0);
  });

  await testAsync("sync throw no async com callback → rejeita via callback", async () => {
    const bad = (..._a) => 0;
    bad.async = () => {
      throw new TypeError("Expected 3 arguments, got 2");
    };
    const wrapped = __wrapKoffiFunc(bad, "POS_Inicializar");
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          wrapped.async("a", "b", (err, v) => (err ? reject(err) : resolve(v)));
        }),
      /Expected 3 arguments, got 2/,
    );
  });

  test("classifyPrintError — arity koffi não é retryável em loop", () => {
    const { classifyPrintError } = require("../print/printErrors");
    const c = classifyPrintError(new TypeError("Expected 3 arguments, got 2"));
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.fallbackSuggested, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
