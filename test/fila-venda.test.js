/**
 * Testes — fila local-first (registrarLocalFirst)
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const testDir = path.join(__dirname, "data-fila-venda");
const dbPath = path.join(testDir, "fila.db");

function rmDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) rmDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

rmDir(testDir);
fs.mkdirSync(testDir, { recursive: true });

process.env.DB_PATH = dbPath;
process.env.BACKEND_URL = "";
process.env.BACKEND_TOKEN = "";

const fila = require("../fila");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

console.log("fila-venda.test.js\n");

fila.inicializar();

const payload = {
  numeroVendaCliente: "PDV-TEST-LOCAL-1",
  itens: [
    {
      produtoId: "p1",
      codigo: "1",
      nome: "Item",
      quantidade: 2,
      precoUnitario: 10,
      custoUnitario: 6,
      margem: 40,
    },
  ],
  formaPagamento: "dinheiro",
  total: 20,
  desconto: 0,
  operador: "Teste",
  emitirNfce: true,
};

(async () => {
  await test("montarRespostaVenda — contrato RespostaVenda", () => {
    const r = fila.montarRespostaVenda(payload, {
      origem: "local",
      syncPendente: true,
    });
    assert.strictEqual(r.numeroVenda, "PDV-TEST-LOCAL-1");
    assert.strictEqual(r.origem, "local");
    assert.strictEqual(r.syncPendente, true);
    assert.strictEqual(r.precisaEmitirFiscal, true);
    assert.strictEqual(r.statusFiscal, "PENDENTE");
    assert.strictEqual(r.total, 20);
    assert.ok(r.lucro > 0);
    assert.ok(r.margem > 0);
  });

  await test("registrarLocalFirst — enfileira e responde sem bloquear", async () => {
    const r = await fila.registrarLocalFirst({
      ...payload,
      numeroVendaCliente: "PDV-TEST-LOCAL-2",
    });
    assert.strictEqual(r.numeroVenda, "PDV-TEST-LOCAL-2");
    assert.strictEqual(r.origem, "local");
    assert.strictEqual(r.syncPendente, true);
    const lista = fila.listar();
    const row = lista.find((x) => x.numero_venda === "PDV-TEST-LOCAL-2");
    assert.ok(row, "deveria estar na fila SQLite");
    assert.strictEqual(row.status, "PENDENTE");
  });

  await test("registrarLocalFirst — idempotente (INSERT OR IGNORE)", async () => {
    const p = { ...payload, numeroVendaCliente: "PDV-TEST-LOCAL-3" };
    await fila.registrarLocalFirst(p);
    await fila.registrarLocalFirst(p);
    const lista = fila.listar().filter((x) => x.numero_venda === "PDV-TEST-LOCAL-3");
    assert.strictEqual(lista.length, 1);
  });

  await test("metricas — expõe limites e antiguidade da fila", async () => {
    await fila.registrarLocalFirst({
      ...payload,
      numeroVendaCliente: "PDV-TEST-LOCAL-4",
    });
    const m = fila.metricas();
    assert.ok(m.total >= 1);
    assert.ok(m.pendentes >= 1);
    assert.ok(typeof m.limiteAviso === "number");
    assert.ok(typeof m.limiteCritico === "number");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
