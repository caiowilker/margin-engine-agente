#!/usr/bin/env node
/**
 * Guarda de ociosidade do update remoto.
 */
const assert = require("assert");
const {
  avaliarProntidaoUpdate,
  coletarBloqueiosUpdate,
  requireIdleHabilitado,
} = require("../updaterIdleGuard");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}:`, e.message);
  }
}

console.log("\nupdater-idle-guard\n");

test("requireIdleHabilitado — padrão true", () => {
  assert.strictEqual(requireIdleHabilitado({}), true);
  assert.strictEqual(requireIdleHabilitado({ UPDATE_REQUIRE_IDLE: "false" }), false);
});

test("ocioso — ok sem force", () => {
  const r = avaliarProntidaoUpdate({
    deps: {
      fiscalEmUso: () => false,
      filaFiscal: { estaProcessando: () => false, status: () => ({ pendentes: 0 }) },
      fila: { status: () => ({ pendentes: 0 }) },
    },
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.bloqueios, []);
});

test("fiscal em uso — bloqueia", () => {
  const r = avaliarProntidaoUpdate({
    deps: {
      fiscalEmUso: () => true,
      filaFiscal: { estaProcessando: () => false, status: () => ({ pendentes: 0 }) },
      fila: { status: () => ({ pendentes: 0 }) },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.bloqueios.some((b) => /fiscal|ACBr/i.test(b)));
  assert.match(r.mensagem, /adiada|ocupado/i);
});

test("force libera mesmo ocupado", () => {
  const r = avaliarProntidaoUpdate({
    force: true,
    deps: {
      fiscalEmUso: () => true,
      filaFiscal: { estaProcessando: () => true, status: () => ({ pendentes: 2 }) },
      fila: { status: () => ({ pendentes: 1 }) },
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.forçado, true);
  assert.ok(r.bloqueios.length >= 1);
});

test("UPDATE_REQUIRE_IDLE=false não bloqueia", () => {
  const r = avaliarProntidaoUpdate({
    env: { UPDATE_REQUIRE_IDLE: "false" },
    deps: {
      fiscalEmUso: () => true,
      filaFiscal: { estaProcessando: () => false, status: () => ({ pendentes: 0 }) },
      fila: { status: () => ({ pendentes: 0 }) },
    },
  });
  assert.strictEqual(r.ok, true);
});

test("coletarBloqueios — fila offline", () => {
  const b = coletarBloqueiosUpdate({
    fiscalEmUso: () => false,
    filaFiscal: { estaProcessando: () => false, status: () => ({ pendentes: 0 }) },
    fila: { contadores: () => ({ pendentes: 3 }) },
  });
  assert.ok(b.some((x) => /offline/i.test(x) && /3/.test(x)));
});

console.log(`\nupdater-idle-guard: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
