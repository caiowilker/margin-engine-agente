#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  montarPayloadHeartbeat,
  normalizarFilaFiscal,
  AGENT_VERSION,
} = require("../heartbeatPayload");
const { lerFrontBuildId } = require("../frontVersion");

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

function run() {
  console.log("\nHeartbeat version telemetry\n");

  test("fila fiscal intacta no payload", () => {
    const fila = {
      pendentes: 2,
      incerto: 1,
      processando: 0,
      recuperando: 0,
      falhasTemporarias: 0,
      falhas: 3,
      concluidos: 10,
      pausada: false,
    };
    const payload = montarPayloadHeartbeat(fila, {
      frontVersion: "abc123",
      providerId: "agent-local-lib",
    });
    assert.deepStrictEqual(payload.filaFiscal, normalizarFilaFiscal(fila));
    assert.strictEqual(payload.providerId, "agent-local-lib");
    assert.strictEqual(payload.agentVersion, AGENT_VERSION);
    assert.strictEqual(payload.frontVersion, "abc123");
  });

  test("sem frontVersion quando arquivo ausente", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-front-"));
    const payload = montarPayloadHeartbeat({}, { baseDir: tmp });
    assert.strictEqual(payload.agentVersion, AGENT_VERSION);
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, "frontVersion"));
  });

  test("lê frontVersion de version.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "me-front-"));
    const dist = path.join(tmp, "frontend-dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, "version.json"),
      JSON.stringify({ version: "1.0.0", buildId: "deadbeef12" }),
    );
    assert.strictEqual(lerFrontBuildId(tmp), "deadbeef12");
    const payload = montarPayloadHeartbeat({}, { baseDir: tmp });
    assert.strictEqual(payload.frontVersion, "deadbeef12");
  });

  test("payload legado simulado — só providerId e filaFiscal", () => {
    const legado = {
      providerId: "agent-local-monitor",
      filaFiscal: normalizarFilaFiscal({ pendentes: 1 }),
    };
    assert.ok(legado.filaFiscal);
    assert.strictEqual(legado.filaFiscal.pendentes, 1);
    assert.ok(!legado.agentVersion);
  });

  console.log(`\nHeartbeat version telemetry: ${passed} ok, ${failed} falha(s)\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
