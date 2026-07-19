#!/usr/bin/env node
/**
 * CT-e/MDF-e: capability gate e contratos fail-closed.
 * Nenhum teste carrega DLL nem chama ACBr/SEFAZ.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DOCUMENTOS,
  verificarCapacidadeTransporte,
} = require("../fiscal/transporteCapability");
const {
  criarHandlerTransporte,
  registrarRotasTransporte,
} = require("../fiscal/transporteRoutes");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function withTempArtefatos(documento, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agente-transporte-"));
  const def = DOCUMENTOS[documento];
  const dll = path.join(root, def.dll);
  const ini = path.join(root, `${documento}.ini`);
  const schemas = path.join(root, def.schemaDirs[0]);
  fs.mkdirSync(schemas, { recursive: true });
  fs.writeFileSync(dll, "");
  fs.writeFileSync(ini, "[Principal]\n");
  fs.writeFileSync(path.join(schemas, "schema.xsd"), "<schema/>");
  try {
    return fn({
      [`${def.envPrefix}_LIB_PATH`]: dll,
      [`${def.envPrefix}_INI`]: ini,
      [`${def.envPrefix}_SCHEMAS_PATH`]: root,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function responseSpy() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

console.log("\nCT-e/MDF-e capability tests\n");

test("CT-e reporta todos os requisitos ausentes", () => {
  const result = verificarCapacidadeTransporte("cte", {
    ACBR_CTE_LIB_PATH: "/nao-existe/ACBrCTe64.dll",
    ACBR_CTE_INI: "/nao-existe/acbrcte.ini",
    ACBR_CTE_SCHEMAS_PATH: "/nao-existe/schemas",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "CAPABILITY_UNAVAILABLE");
  assert.deepStrictEqual(result.ausentes, ["dll", "schemas", "config"]);
});

test("MDF-e reconhece DLL, schemas e configuração explicitamente fornecidos", () => {
  withTempArtefatos("mdfe", (env) => {
    const result = verificarCapacidadeTransporte("mdfe", env);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.ausentes, []);
  });
});

test("handler bloqueia CT-e antes de qualquer adaptador fiscal", async () => {
  let detectorCalls = 0;
  const handler = criarHandlerTransporte("cte", "EMITIR_CTE", () => {
    detectorCalls++;
    return {
      ok: false,
      nome: "CT-e",
      ausentes: ["dll", "schemas", "config"],
    };
  });
  const res = responseSpy();
  await handler({ headers: {} }, res);
  assert.strictEqual(detectorCalls, 1);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.codigo, "CAPABILITY_UNAVAILABLE");
  assert.deepStrictEqual(res.body.requisitosAusentes, ["dll", "schemas", "config"]);
});

test("handler permanece fail-closed mesmo com pré-requisitos presentes", async () => {
  const handler = criarHandlerTransporte("mdfe", "ENCERRAR_MDFE", () => ({
    ok: true,
    nome: "MDF-e",
    ausentes: [],
  }));
  const res = responseSpy();
  await handler({ headers: {} }, res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.codigo, "CAPABILITY_UNAVAILABLE");
  assert.deepStrictEqual(res.body.requisitosAusentes, ["adaptador_fiscal"]);
});

test("registra as cinco rotas de transporte protegidas", () => {
  const routes = [];
  const app = {
    post(route, ...handlers) {
      routes.push({ route, handlers });
    },
  };
  const privateNetworkHeaders = () => {};
  const exigirAgentToken = () => {};
  registrarRotasTransporte(app, [privateNetworkHeaders, exigirAgentToken]);

  assert.deepStrictEqual(
    routes.map(({ route }) => route),
    [
      "/fiscal/emitir-cte",
      "/fiscal/cancelar-cte",
      "/fiscal/emitir-mdfe",
      "/fiscal/encerrar-mdfe",
      "/fiscal/incluir-condutor-mdfe",
    ],
  );
  for (const { handlers } of routes) {
    assert.strictEqual(handlers[0], privateNetworkHeaders);
    assert.strictEqual(handlers[1], exigirAgentToken);
    assert.strictEqual(typeof handlers[2], "function");
  }
});

test("adapter disponível reutiliza preflight, fila e correlationId", async () => {
  const calls = [];
  const handler = criarHandlerTransporte(
    "cte",
    "EMITIR_CTE",
    () => ({ ok: true, nome: "CT-e", ausentes: [] }),
    () => ({
      async preflight(command) {
        calls.push(["preflight", command]);
        return { ok: true };
      },
      async enqueue(command) {
        calls.push(["enqueue", command]);
        return { status: "ENFILEIRADO", queueId: "queue-1" };
      },
    }),
    async () => ({ filaFiscal: "fila", fiscalPreflight: "preflight", fiscalService: "callback" }),
  );
  const res = responseSpy();

  await handler(
    { headers: { "x-correlation-id": "corr-cte-1" }, body: { numeroDocumento: "CTE-1" } },
    res,
  );

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.status, "ENFILEIRADO");
  assert.strictEqual(res.body.correlationId, "corr-cte-1");
  assert.deepStrictEqual(calls.map(([name]) => name), ["preflight", "enqueue"]);
  assert.strictEqual(calls[0][1].contexto.filaFiscal, "fila");
  assert.strictEqual(calls[1][1].payload.correlationId, "corr-cte-1");
});

test("adapter disponível exige correlationId", async () => {
  const handler = criarHandlerTransporte(
    "mdfe",
    "EMITIR_MDFE",
    () => ({ ok: true, nome: "MDF-e", ausentes: [] }),
    () => ({ preflight: async () => ({ ok: true }), enqueue: async () => ({}) }),
  );
  const res = responseSpy();
  await handler({ headers: {}, body: {} }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.codigo, "CORRELATION_ID_REQUIRED");
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}:`, error.message);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
