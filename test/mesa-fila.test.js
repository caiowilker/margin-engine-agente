/**
 * Testes unitários da fila de mesas offline (SQLite).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("mesaFila", () => {
  let tmp;
  let mesaFila;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesa-fila-test-"));
    process.env.DB_PATH = path.join(tmp, "fila.db");
    delete require.cache[require.resolve("../mesaFila")];
    mesaFila = require("../mesaFila");
    mesaFila.inicializar();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("persiste snapshot e mescla ocupação local", () => {
    mesaFila.salvarSnapshot([
      { id: "t1", code: "1", status: "livre", display_order: 1 },
    ]);
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 15,
      order_items_count: 1,
    });
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].status, "ocupada");
    assert.equal(merged[0].order_total, 15);
  });

  it("enfileira OPEN e conta pendentes", () => {
    const r = mesaFila.enfileirarOp({
      tipo: "OPEN",
      mesa_id: "t1",
      payload: { client_order_number: "c1" },
    });
    assert.ok(r.id);
    const c = mesaFila.contadores();
    assert.equal(c.pendentes, 1);
  });

  it("deduplica SYNC pendente por mesa", () => {
    mesaFila.enfileirarOp({
      tipo: "SYNC",
      mesa_id: "t1",
      payload: { sync: { items: [] } },
    });
    mesaFila.enfileirarOp({
      tipo: "SYNC",
      mesa_id: "t1",
      payload: { sync: { items: [{ code: "A" }] } },
    });
    const ops = mesaFila.listarOps({ status: "PENDENTE" });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].payload.sync.items[0].code, "A");
  });

  it("cancela CLOSE/RELEASE e preserva OPEN no faturar", () => {
    mesaFila.enfileirarOp({
      tipo: "OPEN",
      mesa_id: "t1",
      payload: { client_order_number: "c1" },
    });
    mesaFila.enfileirarOp({
      tipo: "SYNC",
      mesa_id: "t1",
      payload: { sync: { items: [] } },
    });
    mesaFila.enfileirarOp({
      tipo: "CLOSE",
      mesa_id: "t1",
      payload: { sync: { items: [] } },
    });
    const r = mesaFila.cancelarOpsMesa("t1", { keep: ["OPEN", "SYNC"] });
    assert.ok(r.cancelados >= 1);
    const pendentes = mesaFila.listarOps({ status: "PENDENTE" });
    assert.equal(pendentes.length, 2);
    assert.ok(pendentes.every((o) => o.tipo === "OPEN" || o.tipo === "SYNC"));
  });

  it("adia venda ORDER-* enquanto OPEN pendente", () => {
    mesaFila.enfileirarOp({
      tipo: "OPEN",
      mesa_id: "t1",
      payload: { client_order_number: "abc" },
    });
    assert.equal(mesaFila.deveAdiarVendaOrder("ORDER-abc"), true);
    assert.equal(mesaFila.deveAdiarVendaOrder("ORDER-other"), false);
    assert.equal(mesaFila.deveAdiarVendaOrder("V-1"), false);
  });
});
