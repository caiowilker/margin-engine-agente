/**
 * Prioridade na fila — PRE_CONTA/comanda antes de teste antigo.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(os.tmpdir(), `me-print-prio-${process.pid}`);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.PRINTER_PROVIDER = "mock";
process.env.PRINT_JOB_WORKER = "false";

const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
getDirectoryManager(ROOT).ensureAll();

const store = require("../print/printJobStore");
const pjs = require("../print/printJobService");

function cleanup() {
  try {
    store.resetDbForTests();
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
}

async function run() {
  store.resetDbForTests();
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
  store.initDb();

  // Job antigo de baixa prioridade (teste)
  const teste = pjs.enfileirar("imprimirTeste", [], { motivo: "prio_teste" });
  assert.ok(teste.id);

  // Job novo urgente (comanda / PRE_CONTA)
  const pre = pjs.enfileirar(
    "imprimirPedido",
    [
      {
        eventType: "PRE_CONTA",
        orderId: "ord-1",
        orderNumber: "1",
        tableCode: "5",
        total: 10,
        items: [{ code: "A", name: "X", quantity: 1 }],
      },
    ],
    { motivo: "prio_preconta" },
  );
  assert.ok(pre.id);

  const next = store.proximoJobPronto();
  assert.ok(next, "deve haver job pronto");
  assert.strictEqual(
    next.id,
    pre.id,
    `PRE_CONTA deve sair antes do teste (got tipo=${next.tipo} id=${next.id})`,
  );
  assert.ok(Number(next.prioridade) <= 1, `prioridade comanda=${next.prioridade}`);

  // Job fiscal também prioridade 2 (não atrás de teste)
  const fiscal = pjs.enfileirar(
    "imprimirCupom",
    [{ chaveNfe: "35240100000000000000550010000000011000000010", total: 10 }],
    { motivo: "prio_fiscal" },
  );
  assert.ok(fiscal.id);
  const rowFiscal = store.buscarJob(fiscal.id);
  assert.ok(
    Number(rowFiscal.prioridade) <= 2,
    `cupom_fiscal prioridade=${rowFiscal.prioridade}`,
  );

  cleanup();
  console.log("print-job-priority.test.js — OK");
}

run().catch((err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
