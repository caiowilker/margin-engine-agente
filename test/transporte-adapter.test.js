#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  CONTRACTS,
  validateBinding,
} = require("../fiscal/drivers/transporteNativeBinding");
const {
  createTransportFiscalAdapter,
} = require("../fiscal/drivers/transporteFiscalAdapter");

function mockBinding(documento) {
  const out = {};
  for (const name of Object.keys(CONTRACTS[documento].exports)) {
    out[name] = () => ({ cStat: "100", chave: "123", xml: "<xml/>" });
  }
  return out;
}

async function main() {
  console.log("transporte-adapter.test.js\n");

  assert.throws(
    () => validateBinding("cte", {}),
    /ACBrCTe binding incompleto/,
  );
  console.log("  ✓ binding exige exports ACBrCTe documentados");

  const handlers = new Map();
  const calls = [];
  const queue = {
    registrarHandler: (type, handler) => handlers.set(type, handler),
    enfileirar: (type, payload, correlationId, numeroDocumento) => {
      calls.push({ type, payload, correlationId, numeroDocumento });
      return { id: 42, deduplicado: false };
    },
    dispararProcessamento: () => calls.push({ type: "DISPARAR" }),
  };
  const adapter = createTransportFiscalAdapter({
    detector: () => ({ ok: true, nome: "CT-e", ausentes: [], paths: { dll: "fake", config: "fake.ini" } }),
    getBinding: () => mockBinding("cte"),
  });
  const before = process.env.TRANSPORT_CTE_ENABLED;
  process.env.TRANSPORT_CTE_ENABLED = "true";
  try {
    const command = {
      documento: "cte",
      operacao: "EMITIR_CTE",
      correlationId: "cte-corr-1",
      payload: { numeroDocumento: "CTE-1", numero: 1, documentIni: "[CTe]\nNumero=1" },
      contexto: { filaFiscal: queue, lerConfig: async () => ({}) },
    };
    assert.deepStrictEqual(await adapter.preflight(command), { ok: true });
    const result = await adapter.enqueue(command);
    assert.strictEqual(result.queueId, 42);
    assert.strictEqual(calls[0].type, "TRANSPORTE_CTE_EMITIR_CTE");
    assert.strictEqual(calls[0].payload.modeloDocumento, "57");
    assert.ok(handlers.has("TRANSPORTE_CALLBACK"));
    console.log("  ✓ CT-e usa fila própria, idempotência e modelo 57");

    const mdfeAdapter = createTransportFiscalAdapter({
      detector: () => ({ ok: true, nome: "MDF-e", ausentes: [], paths: { dll: "fake", config: "fake.ini" } }),
      getBinding: () => mockBinding("mdfe"),
    });
    process.env.TRANSPORT_MDFE_ENABLED = "true";
    await mdfeAdapter.enqueue({
      documento: "mdfe",
      operacao: "EMITIR_MDFE",
      correlationId: "mdfe-corr-1",
      payload: { numeroDocumento: "MDFE-1", numero: 1, documentIni: "[MDFe]\nNumero=1" },
      contexto: { filaFiscal: queue, lerConfig: async () => ({}) },
    });
    assert.strictEqual(calls[2].payload.modeloDocumento, "58");
    console.log("  ✓ MDF-e reserva numeração independente no modelo 58");
  } finally {
    if (before === undefined) delete process.env.TRANSPORT_CTE_ENABLED;
    else process.env.TRANSPORT_CTE_ENABLED = before;
    delete process.env.TRANSPORT_MDFE_ENABLED;
  }

  console.log("\nOK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
