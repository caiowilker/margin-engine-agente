/**
 * Testes — idempotência de impressão (anti-duplicata física).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(os.tmpdir(), `me-print-idem-${process.pid}-${Date.now()}`);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.PRINTER_PROVIDER = "mock";
process.env.PRINT_JOB_WORKER = "false";
process.env.PRINT_JOB_MAX_TENTATIVAS = "2";
process.env.PRINT_JOB_TIMEOUT_TOTAL_MS = "5000";

const { getDirectoryManager, resetDirectoryManager } = require("../runtime/directoryManager");
resetDirectoryManager();
getDirectoryManager(ROOT).ensureAll();

const {
  resolveIdempotencyKey,
  fingerprintPedido,
  deveDeduplicar,
} = require("../print/printIdempotency");
const store = require("../print/printJobStore");
const pjs = require("../print/printJobService");
const factory = require("../print/factory");

factory.resetPrintProvider();

test("resolveIdempotencyKey — vasilhame por código (anti-retry) e reimpressão", () => {
  assert.equal(
    resolveIdempotencyKey(
      "imprimirVasilhame",
      [{ codigoTransacao: "VAS42", naoFiscal: true }],
      {},
    ),
    "vasilhame:VAS42",
  );
  assert.equal(
    resolveIdempotencyKey(
      "imprimirVasilhame",
      [{ codigo: "vas7", naoFiscal: true }],
      {},
    ),
    "vasilhame:VAS7",
  );
  const sv = resolveIdempotencyKey(
    "imprimirVasilhame",
    [
      {
        codigoTransacao: "VAS42",
        clickId: "abc123",
        motivo: "reimpressao_vasilhame",
      },
    ],
    {},
  );
  assert.equal(sv, "vasilhame:sv:VAS42:abc123");
});

test("resolveIdempotencyKey — cloud jobId e PRE_CONTA", () => {
  assert.equal(
    resolveIdempotencyKey("imprimirPedido", [{ jobId: "uuid-1", printType: "cozinha" }], {}),
    "cloud:uuid-1",
  );
  const pre = resolveIdempotencyKey(
    "imprimirPedido",
    [
      {
        eventType: "PRE_CONTA",
        orderId: "ord-1",
        printType: "cliente",
        total: 10,
        items: [{ code: "A", name: "X", quantity: 1, lineTotal: 10 }],
      },
    ],
    {},
  );
  assert.ok(pre.startsWith("preconta:ord-1:"));
  assert.equal(
    resolveIdempotencyKey("imprimirPedido", [{ eventType: "PRE_CONTA", orderId: "ord-1" }], {
      force: true,
    }),
    null,
  );
});

test("resolveIdempotencyKey — cupom por numeroVenda (anti-retry front)", () => {
  assert.equal(
    resolveIdempotencyKey("imprimirCupom", [{ numeroVenda: "V-100", naoFiscal: true }], {}),
    "imprimirCupom:nf:V-100",
  );
  assert.equal(
    resolveIdempotencyKey("imprimirCupom", [{ numeroVenda: "V-100", chaveNfe: "35..." }], {}),
    "imprimirCupom:cupom:V-100",
  );
  // segundaVia sozinho NÃO muda a chave (checkout legado) — precisa reimpressao/motivo
  assert.equal(
    resolveIdempotencyKey(
      "imprimirCupom",
      [{ numeroVenda: "V-100", naoFiscal: true, segundaVia: true }],
      {},
    ),
    "imprimirCupom:nf:V-100",
  );
  const sv = resolveIdempotencyKey(
    "imprimirCupom",
    [
      {
        numeroVenda: "V-100",
        naoFiscal: true,
        reimpressao: true,
        motivo: "segunda_via",
        emitidoEm: "2026-07-30T12:00:00.000Z",
      },
    ],
    {},
  );
  assert.ok(sv.startsWith("imprimirCupom:sv:V-100:"));
});

test("resolveIdempotencyKey — relatório por clickId (anti-retry)", () => {
  const payload = {
    operador: "Maria",
    faturamento: 10,
    vendas: [{ numero: "V1", total: 10 }],
    itens: [{ codigo: "A", nome: "X", quantidade: 1, total: 10 }],
    clickId: "clk-rel-1",
  };
  assert.equal(
    resolveIdempotencyKey("imprimirRelatorio", [payload], {}),
    "relatorio:clk-rel-1",
  );
  const semClick = resolveIdempotencyKey(
    "imprimirRelatorio",
    [{ ...payload, clickId: undefined }],
    {},
  );
  assert.ok(String(semClick).startsWith("relatorio:fp:"));
});

test("fingerprint estável — createdAt não entra", () => {
  const a = fingerprintPedido({
    orderId: "o",
    printType: "cliente",
    eventType: "PRE_CONTA",
    total: 5,
    items: [{ code: "1", name: "A", quantity: 1, lineTotal: 5 }],
    createdAt: "a",
  });
  const b = fingerprintPedido({
    orderId: "o",
    printType: "cliente",
    eventType: "PRE_CONTA",
    total: 5,
    items: [{ code: "1", name: "A", quantity: 1, lineTotal: 5 }],
    createdAt: "b",
  });
  assert.equal(a, b);
});

test("enfileirar deduplica e não reimprime", async () => {
  store.resetDbForTests();
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
  store.initDb();
  factory.resetPrintProvider();
  const mock = factory.getPrintProvider();
  mock._clearJobs?.();

  const payload = {
    eventType: "PRE_CONTA",
    orderId: "ord-dup",
    orderNumber: "Mesa-1",
    printType: "cliente",
    total: 20,
    copies: 1,
    items: [{ code: "P", name: "Pizza", quantity: 1, lineTotal: 20 }],
  };

  const j1 = pjs.enfileirar("imprimirPedido", [payload], {});
  assert.equal(j1.deduplicado, false);
  await pjs.processarFila();
  const done = pjs.buscarJob(j1.id);
  assert.equal(done.status, "IMPRESSO");

  const j2 = pjs.enfileirar("imprimirPedido", [payload], {});
  assert.equal(j2.deduplicado, true);
  assert.equal(j2.id, j1.id);

  const r = await pjs.submitPrint("imprimirPedido", [payload], {});
  assert.equal(r.ok, true);
  assert.equal(r.deduplicado, true);

  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
});

test("deveDeduplicar — ERRO não bloqueia nova tentativa", () => {
  assert.equal(deveDeduplicar({ status: "ERRO" }), false);
  assert.equal(deveDeduplicar({ status: "PENDENTE" }), true);
  assert.equal(
    deveDeduplicar({
      status: "IMPRESSO",
      impresso_em: new Date().toISOString(),
    }),
    true,
  );
});

test("enfileirar após ERRO libera chave UNIQUE e cria novo job", async () => {
  store.resetDbForTests();
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
  store.initDb();
  factory.resetPrintProvider();

  const payload = {
    naoFiscal: true,
    cupomSemFiscal: true,
    numeroVenda: "V-ERRO-RETRY",
    itens: [{ descricao: "X", qtd: 1, total: 1 }],
    total: 1,
  };
  const j1 = pjs.enfileirar("imprimirCupom", [payload], {});
  assert.equal(j1.deduplicado, false);
  store.atualizarJob(j1.id, { status: "ERRO", erro: "falha simulada" });

  const j2 = pjs.enfileirar("imprimirCupom", [payload], {});
  assert.equal(j2.deduplicado, false);
  assert.notEqual(j2.id, j1.id);
  assert.equal(j2.status, "PENDENTE");
  const old = store.buscarJob(j1.id);
  assert.equal(old.idempotency_key, null);

  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
});

test("reimprimir manual ignora chave e gera novo job", async () => {
  store.resetDbForTests();
  resetDirectoryManager();
  getDirectoryManager(ROOT).ensureAll();
  store.initDb();
  factory.resetPrintProvider();

  const payload = {
    eventType: "PRE_CONTA",
    orderId: "ord-re",
    orderNumber: "M-2",
    printType: "cliente",
    total: 15,
    copies: 1,
    items: [{ code: "X", name: "Item", quantity: 1, lineTotal: 15 }],
  };
  const j1 = pjs.enfileirar("imprimirPedido", [payload], {});
  await pjs.processarFila();
  assert.equal(pjs.buscarJob(j1.id).status, "IMPRESSO");

  const reprint = pjs.reimprimir(j1.id, { motivo: "teste_manual" });
  assert.equal(reprint.deduplicado, false);
  assert.notEqual(reprint.id, j1.id);
  assert.equal(reprint.jobPaiId, j1.id);

  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
});
