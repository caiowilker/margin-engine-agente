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
      closed_for_billing: false,
    });
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].status, "ocupada");
    assert.equal(merged[0].order_total, 15);
    assert.equal(merged[0].closed_for_billing, false);
  });

  it("não zera consumo quando local=0 e snapshot tem itens", () => {
    mesaFila.salvarSnapshot([
      {
        id: "t1",
        code: "1",
        status: "ocupada",
        display_order: 1,
        open_order_id: "srv",
        order_total: 40,
        order_items_count: 3,
      },
    ]);
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "stale",
      client_order_number: "stale",
      status: "ocupada",
      order_total: 0,
      order_items_count: 0,
      closed_for_billing: false,
      server_order_id: "srv",
    });
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].order_items_count, 3);
    assert.equal(merged[0].order_total, 40);
    assert.equal(merged[0].status, "ocupada");
  });

  it("preserva pré-conta do snapshot quando local ainda não fechou", () => {
    mesaFila.salvarSnapshot([
      {
        id: "t1",
        code: "1",
        status: "ocupada",
        display_order: 1,
        open_order_id: "o1",
        order_total: 20,
        order_items_count: 1,
        closed_for_billing: true,
      },
    ]);
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 20,
      order_items_count: 1,
      closed_for_billing: false,
    });
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].closed_for_billing, true);
  });

  it("removerLocal marca mesa livre no snapshot (pós-faturar)", () => {
    mesaFila.salvarSnapshot([
      {
        id: "t1",
        code: "1",
        status: "ocupada",
        display_order: 1,
        open_order_id: "o1",
        order_total: 50,
        order_items_count: 2,
        closed_for_billing: true,
      },
    ]);
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 50,
      order_items_count: 2,
      closed_for_billing: true,
    });
    mesaFila.removerLocal("t1");
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].status, "livre");
    assert.equal(merged[0].closed_for_billing, false);
    assert.equal(merged[0].order_items_count, 0);
  });

  it("snapshot livre vence pré-conta local stale", () => {
    mesaFila.salvarSnapshot([
      {
        id: "t1",
        code: "1",
        status: "livre",
        display_order: 1,
        open_order_id: null,
        order_total: 0,
        order_items_count: 0,
        closed_for_billing: false,
      },
    ]);
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 30,
      order_items_count: 2,
      closed_for_billing: true,
    });
    const merged = mesaFila.mesclarSnapshotComLocal();
    assert.equal(merged[0].status, "livre");
    assert.equal(merged[0].closed_for_billing, false);
  });

  it("não apaga draft_json existente quando upsert vem sem draft", () => {
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 10,
      order_items_count: 1,
      draft_json: { carrinho: [{ id: "p1" }] },
    });
    mesaFila.upsertLocal({
      mesa_id: "t1",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 12,
      order_items_count: 1,
      draft_json: null,
    });
    const locais = mesaFila.listarLocal();
    assert.equal(locais[0].order_total, 12);
    assert.ok(locais[0].draft_json);
    assert.equal(locais[0].draft_json.carrinho[0].id, "p1");
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
    assert.equal(mesaFila.deveAdiarVendaOrder("ORDER-other"), false);
    assert.equal(mesaFila.deveAdiarVendaOrder("V-1"), false);
  });

  it("isSyncShrink detecta redução de itens/total", () => {
    assert.equal(mesaFila.isSyncShrink(2, 10, 3, 20), true);
    assert.equal(mesaFila.isSyncShrink(3, 20, 3, 20), false);
  });

  it("upsertLocal incrementa revision e publica mesa.updated", () => {
    const events = [];
    const unsub = mesaFila.subscribeEvents((type, data) => events.push({ type, data }));
    mesaFila.upsertLocal({
      mesa_id: "t-rev",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 10,
      order_items_count: 1,
    });
    const local = mesaFila.obterLocal("t-rev");
    assert.equal(local.revision, 1);
    assert.ok(events.some((e) => e.type === "mesa.updated"));
    mesaFila.upsertLocal({
      mesa_id: "t-rev",
      order_id: "o1",
      client_order_number: "o1",
      status: "ocupada",
      order_total: 20,
      order_items_count: 2,
    });
    assert.equal(mesaFila.obterLocal("t-rev").revision, 2);
    unsub();
  });

  it("applyOp OPEN + ADD_LINES com revision; stale retorna 409", () => {
    const open = mesaFila.applyOp({
      opId: "op-open-1",
      mesaId: "t-apply",
      type: "OPEN",
      baseRevision: 0,
      payload: { order_id: "ord-1", client_order_number: "ord-1" },
    });
    assert.equal(open.status, 200);
    assert.equal(open.body.revision, 1);

    const add = mesaFila.applyOp({
      opId: "op-add-1",
      mesaId: "t-apply",
      type: "ADD_LINES",
      baseRevision: 1,
      payload: { order_items_count: 2, order_total: 30 },
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.revision, 2);

    const stale = mesaFila.applyOp({
      opId: "op-add-stale",
      mesaId: "t-apply",
      type: "ADD_LINES",
      baseRevision: 1,
      payload: { order_items_count: 1, order_total: 10 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "STALE_REVISION");

    const dup = mesaFila.applyOp({
      opId: "op-add-1",
      mesaId: "t-apply",
      type: "ADD_LINES",
      baseRevision: 1,
      payload: { order_items_count: 2, order_total: 30 },
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.duplicate, true);
  });

  it("applyOp CLOSE_BILL libera e publica mesa.freed", () => {
    mesaFila.applyOp({
      opId: "op-open-2",
      mesaId: "t-close",
      type: "OPEN",
      baseRevision: 0,
      payload: { order_id: "o2", client_order_number: "o2", order_items_count: 1, order_total: 5 },
    });
    const events = [];
    const unsub = mesaFila.subscribeEvents((type, data) => events.push({ type, data }));
    const close = mesaFila.applyOp({
      opId: "op-close-1",
      mesaId: "t-close",
      type: "CLOSE_BILL",
      baseRevision: 1,
      payload: {},
    });
    assert.equal(close.status, 200);
    assert.equal(mesaFila.obterLocal("t-close").status, "livre");
    assert.ok(events.some((e) => e.type === "mesa.freed"));
    unsub();
  });

  it("applyOp SYNC shrink bloqueia", () => {
    mesaFila.applyOp({
      opId: "op-open-3",
      mesaId: "t-shrink",
      type: "OPEN",
      baseRevision: 0,
      payload: {
        order_id: "o3",
        client_order_number: "o3",
        order_items_count: 3,
        order_total: 30,
      },
    });
    const shrink = mesaFila.applyOp({
      opId: "op-sync-shrink",
      mesaId: "t-shrink",
      type: "SYNC",
      baseRevision: 1,
      payload: { order_items_count: 1, order_total: 10 },
    });
    assert.equal(shrink.status, 409);
    assert.equal(shrink.body.code, "SHRINK_BLOCKED");
  });

  it("applyOp ADD_LINES shrink bloqueia", () => {
    mesaFila.applyOp({
      opId: "op-open-add-shrink",
      mesaId: "t-add-shrink",
      type: "OPEN",
      baseRevision: 0,
      payload: {
        order_id: "o4",
        client_order_number: "o4",
        order_items_count: 4,
        order_total: 40,
      },
    });
    // ADD_LINES com revision correta PODE reduzir (edição autoritativa).
    const okReduce = mesaFila.applyOp({
      opId: "op-add-reduce",
      mesaId: "t-add-shrink",
      type: "ADD_LINES",
      baseRevision: 1,
      payload: { order_items_count: 1, order_total: 5 },
    });
    assert.equal(okReduce.status, 200);
    assert.equal(mesaFila.obterLocal("t-add-shrink").order_items_count, 1);
  });

  it("upsertLocal shrink retorna SHRINK_BLOCKED sem sobrescrever", () => {
    mesaFila.upsertLocal({
      mesa_id: "t-up-shrink",
      order_id: "o5",
      client_order_number: "o5",
      status: "ocupada",
      order_items_count: 3,
      order_total: 30,
    });
    const blocked = mesaFila.upsertLocal({
      mesa_id: "t-up-shrink",
      order_id: "o5",
      client_order_number: "o5",
      status: "ocupada",
      order_items_count: 1,
      order_total: 5,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "SHRINK_BLOCKED");
    assert.equal(mesaFila.obterLocal("t-up-shrink").order_items_count, 3);
  });

  it("upsertLocal nao reabre sticky livre sem allowReopen", () => {
    mesaFila.upsertLocal({
      mesa_id: "t-livre",
      order_id: "o7",
      client_order_number: "o7",
      status: "ocupada",
      order_items_count: 1,
      order_total: 10,
    });
    mesaFila.marcarLivreNoSnapshot("t-livre");
    const blocked = mesaFila.upsertLocal({
      mesa_id: "t-livre",
      order_id: "o7",
      client_order_number: "o7",
      status: "ocupada",
      order_items_count: 2,
      order_total: 20,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "MESA_CLOSED");
    assert.equal(mesaFila.obterLocal("t-livre").status, "livre");
  });

  it("applyOp OPEN reabre sticky livre (allowReopen)", () => {
    mesaFila.upsertLocal({
      mesa_id: "t-reopen",
      order_id: "o8",
      client_order_number: "o8",
      status: "ocupada",
      order_items_count: 1,
      order_total: 10,
    });
    mesaFila.marcarLivreNoSnapshot("t-reopen");
    assert.equal(mesaFila.obterLocal("t-reopen").status, "livre");
    const r = mesaFila.applyOp({
      opId: "op-reopen-1",
      mesaId: "t-reopen",
      type: "OPEN",
      baseRevision: 0,
      payload: {
        order_id: "o9",
        client_order_number: "o9",
        order_items_count: 2,
        order_total: 25,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(mesaFila.obterLocal("t-reopen").status, "ocupada");
    assert.equal(mesaFila.obterLocal("t-reopen").order_items_count, 2);
  });

  it("enfileirarOp SYNC nao troca payload rico por shrinker", () => {
    mesaFila.enfileirarOp({
      tipo: "SYNC",
      mesa_id: "t-sync-dedup",
      payload: { sync: { items: [{ total: 10 }, { total: 20 }], total: 30 } },
    });
    const skip = mesaFila.enfileirarOp({
      tipo: "SYNC",
      mesa_id: "t-sync-dedup",
      payload: { sync: { items: [{ total: 5 }], total: 5 } },
    });
    assert.equal(skip.skipped, "shrink");
    const ops = mesaFila.listarOps({ status: "PENDENTE" }).filter(
      (o) => o.mesa_id === "t-sync-dedup" && o.tipo === "SYNC",
    );
    assert.equal(ops.length, 1);
    assert.equal(ops[0].payload.sync.items.length, 2);
  });

  it("eventsSince faz replay apos lastId", () => {
    const seen = [];
    const unsub = mesaFila.subscribeEvents((_type, data) => seen.push(data));
    mesaFila.upsertLocal({
      mesa_id: "t-sse",
      order_id: "o6",
      client_order_number: "o6",
      status: "ocupada",
      order_items_count: 1,
      order_total: 10,
    });
    unsub();
    assert.ok(seen.length >= 1);
    const last = seen[seen.length - 1].id;
    mesaFila.upsertLocal({
      mesa_id: "t-sse",
      order_id: "o6",
      client_order_number: "o6",
      status: "ocupada",
      order_items_count: 2,
      order_total: 20,
    });
    const replay = mesaFila.eventsSince(last);
    assert.ok(replay.some((e) => e.type === "mesa.updated" && e.mesaId === "t-sse"));
  });
});
