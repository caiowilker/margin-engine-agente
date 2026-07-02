/**
 * Testes — PrintJobService (fila, retry, auditoria) — Frente 13.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(os.tmpdir(), `me-print-job-${process.pid}`);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.PRINTER_PROVIDER = "mock";
process.env.PRINT_JOB_WORKER = "false";
process.env.PRINT_JOB_MAX_TENTATIVAS = "2";
process.env.PRINT_JOB_TIMEOUT_TOTAL_MS = "5000";

const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
getDirectoryManager(ROOT).ensureAll();

const store = require("../print/printJobStore");
const pjs = require("../print/printJobService");
const factory = require("../print/factory");

factory.resetPrintProvider();

function cleanup() {
  try {
    store.resetDbForTests();
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
}

async function run() {
  try {
    store.resetDbForTests();
  } catch (_) {}
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
  store.initDb();

  const job = pjs.enfileirar("imprimirTeste", [], { motivo: "teste_unit" });
  assert.ok(job.id);
  assert.strictEqual(job.status, "PENDENTE");
  assert.strictEqual(job.tipo, "teste");

  const res = await pjs.processarFila();
  assert.ok(res.processados >= 1);

  const done = pjs.buscarJob(job.id);
  assert.strictEqual(done.status, "IMPRESSO");
  assert.ok(done.duracaoMs != null || done.impressoEm);

  const hist = pjs.listarJobs({ limit: 5 });
  assert.ok(hist.length >= 1);

  const reprint = pjs.reimprimir(job.id, { motivo: "reimpressao_teste" });
  assert.ok(reprint.id);
  assert.strictEqual(reprint.jobPaiId, job.id);

  const obs = pjs.observabilidade();
  assert.ok(obs.fila);
  assert.ok(obs.fila.total >= 2);

  cleanup();
  console.log("print-job-service.test.js — OK");
}

run().catch((err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
