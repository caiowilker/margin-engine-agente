// ============================================================
// PDV Margin Engine — Fila de mesas offline (SQLite)
//
// Persistência durable no agente (:9100) para:
//   • snapshot do mapa de mesas
//   • ocupação local (abertas offline)
//   • fila de ops: OPEN | SYNC | CLOSE | RELEASE
//
// Sync: processa ops antes da fila de vendas (idempotente via
// client_order_number). Faturamento offline usa fila_vendas com
// numeroVendaCliente = ORDER-{clientOrderNumber}.
// ============================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { getDirectoryManager } = require("./runtime/directoryManager");

const DB_PATH = process.env.DB_PATH || getDirectoryManager().file("agent", "fila.db");
const CONFIG_PATH = getDirectoryManager().file("agent", "config.json");
// Mantém coerência com o catálogo remoto: 5s produzia falso offline em picos.
const TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || "12000", 10);

let BACKEND_URL = process.env.BACKEND_URL || "";
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";
let db;
let syncEmAndamento = false;

function carregarConfigPersistida() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.backendUrl) BACKEND_URL = cfg.backendUrl;
    if (cfg.backendToken) BACKEND_TOKEN = cfg.backendToken;
  } catch (err) {
    console.warn("[MesaFila] Falha ao ler config.json:", err.message);
  }
}

function atualizarConfig(url, token) {
  BACKEND_URL = url || "";
  BACKEND_TOKEN = token || "";
  if (url) process.env.BACKEND_URL = url;
  if (token) process.env.BACKEND_TOKEN = token;
}

function inicializar(sharedDb) {
  carregarConfigPersistida();
  if (sharedDb) {
    db = sharedDb;
  } else {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mesa_snapshot (
      id        TEXT PRIMARY KEY CHECK (id = 'current'),
      payload   TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS mesa_local (
      mesa_id              TEXT PRIMARY KEY,
      order_id             TEXT NOT NULL,
      client_order_number  TEXT NOT NULL,
      mesa_codigo          TEXT,
      status               TEXT NOT NULL DEFAULT 'ocupada',
      closed_for_billing   INTEGER NOT NULL DEFAULT 0,
      order_total          REAL NOT NULL DEFAULT 0,
      order_items_count    INTEGER NOT NULL DEFAULT 0,
      draft_json           TEXT,
      server_order_id      TEXT,
      updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS mesa_ops (
      id           TEXT PRIMARY KEY,
      tipo         TEXT NOT NULL,
      mesa_id      TEXT NOT NULL,
      payload      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'PENDENTE',
      tentativas   INTEGER NOT NULL DEFAULT 0,
      ultimo_erro  TEXT,
      criado_em    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sincronizado_em TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mesa_ops_status ON mesa_ops(status);
    CREATE INDEX IF NOT EXISTS idx_mesa_ops_criado ON mesa_ops(criado_em);

    CREATE TABLE IF NOT EXISTS mesa_op_log (
      op_id        TEXT PRIMARY KEY,
      mesa_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      payload      TEXT NOT NULL,
      base_rev     INTEGER NOT NULL,
      new_rev      INTEGER NOT NULL,
      actor_json   TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mesa_op_log_mesa ON mesa_op_log(mesa_id, new_rev);
  `);

  // revision monotônica por mesa (compat com DBs antigos)
  try {
    const cols = db.prepare(`PRAGMA table_info(mesa_local)`).all();
    if (!cols.some((c) => c.name === "revision")) {
      db.exec(`ALTER TABLE mesa_local ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (err) {
    console.warn("[MesaFila] migrate revision:", err.message);
  }

  db.prepare(
    `UPDATE mesa_ops SET status = 'PENDENTE' WHERE status = 'ENVIANDO'`,
  ).run();

  console.log("[MesaFila] Tabelas de mesas offline prontas");
}

function isOplogEnabled() {
  // Default ON — desliga só com MESA_OPLOG=0/false no env ou config.json
  if (process.env.MESA_OPLOG === "0" || process.env.MESA_OPLOG === "false") return false;
  if (process.env.MESA_OPLOG === "1" || process.env.MESA_OPLOG === "true") return true;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.mesaOplog === false || cfg.mesaOplog === 0 || cfg.mesaOplog === "0") return false;
      if (cfg.mesaOplog === true || cfg.mesaOplog === 1 || cfg.mesaOplog === "1") return true;
    }
  } catch {
    /* ignore */
  }
  return true;
}

/** Assinantes SSE: (eventName, data) => void */
const eventListeners = new Set();
let globalEventSeq = 0;
/** Ring buffer para replay em reconnect (Last-Event-ID / lastEventId). */
const EVENT_BUFFER_MAX = 200;
const eventBuffer = [];

function subscribeEvents(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function publishEvent(type, data) {
  globalEventSeq += 1;
  const payload = { id: globalEventSeq, type, ...data, at: new Date().toISOString() };
  eventBuffer.push(payload);
  if (eventBuffer.length > EVENT_BUFFER_MAX) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
  }
  for (const fn of eventListeners) {
    try {
      fn(type, payload);
    } catch {
      /* ignore */
    }
  }
  return payload;
}

/** Eventos com id > lastId (para SSE replay). */
function eventsSince(lastId) {
  const id = Number(lastId) || 0;
  if (id <= 0) return [];
  return eventBuffer.filter((e) => Number(e.id) > id);
}

function isSyncShrink(proposedItems, proposedTotal, knownItems, knownTotal) {
  const pItems = Math.max(0, Number(proposedItems) || 0);
  const kItems = Math.max(0, Number(knownItems) || 0);
  const pTotal = Number(proposedTotal) || 0;
  const kTotal = Number(knownTotal) || 0;
  if (kItems <= 0 && kTotal <= 0) return false;
  if (pItems < kItems) return true;
  if (pItems === kItems && pTotal + 0.009 < kTotal) return true;
  return false;
}

function salvarSnapshot(mesas) {
  if (!db) throw new Error("MesaFila nao inicializada");
  const payload = JSON.stringify(Array.isArray(mesas) ? mesas : []);
  db.prepare(
    `INSERT INTO mesa_snapshot (id, payload, updated_at)
     VALUES ('current', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(payload);
  return { ok: true, count: Array.isArray(mesas) ? mesas.length : 0 };
}

function obterSnapshot() {
  if (!db) return [];
  const row = db.prepare(`SELECT payload FROM mesa_snapshot WHERE id = 'current'`).get();
  if (!row?.payload) return [];
  try {
    const parsed = JSON.parse(row.payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function upsertLocal(state, opts = {}) {
  if (!db) throw new Error("MesaFila nao inicializada");
  if (!state?.mesa_id || !state?.order_id || !state?.client_order_number) {
    throw new Error("mesa_id, order_id e client_order_number obrigatorios");
  }
  const prev = obterLocal(state.mesa_id);
  const nextStatus = state.status ?? "ocupada";
  // Sticky livre: PUT cego não reabre (só OPEN via applyOp com allowReopen).
  if (
    prev &&
    prev.status === "livre" &&
    nextStatus === "ocupada" &&
    !opts.allowReopen
  ) {
    return {
      ok: false,
      code: "MESA_CLOSED",
      revision: prev.revision || 0,
      state: prev,
    };
  }
  // Anti-perda: PUT cego não pode encolher ocupação viva (fallback do front).
  // VOID_LINE explícito passa allowShrink.
  if (
    prev &&
    prev.status === "ocupada" &&
    nextStatus === "ocupada" &&
    !opts.allowShrink &&
    isSyncShrink(
      Number(state.order_items_count) || 0,
      Number(state.order_total) || 0,
      prev.order_items_count,
      prev.order_total,
    )
  ) {
    return {
      ok: false,
      code: "SHRINK_BLOCKED",
      revision: prev.revision || 0,
      state: prev,
    };
  }
  const nextRev = (prev?.revision || 0) + 1;
  db.prepare(
    `INSERT INTO mesa_local (
       mesa_id, order_id, client_order_number, mesa_codigo, status,
       closed_for_billing, order_total, order_items_count, draft_json, server_order_id, updated_at, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(mesa_id) DO UPDATE SET
       order_id = excluded.order_id,
       client_order_number = excluded.client_order_number,
       mesa_codigo = excluded.mesa_codigo,
       status = excluded.status,
       closed_for_billing = excluded.closed_for_billing,
       order_total = excluded.order_total,
       order_items_count = excluded.order_items_count,
       draft_json = CASE
         WHEN excluded.status = 'livre' THEN NULL
         ELSE COALESCE(excluded.draft_json, mesa_local.draft_json)
       END,
       server_order_id = COALESCE(excluded.server_order_id, mesa_local.server_order_id),
       updated_at = excluded.updated_at,
       revision = excluded.revision`,
  ).run(
    state.mesa_id,
    state.order_id,
    state.client_order_number,
    state.mesa_codigo ?? null,
    state.status ?? "ocupada",
    state.closed_for_billing ? 1 : 0,
    Number(state.order_total) || 0,
    Number(state.order_items_count) || 0,
    state.draft_json != null ? JSON.stringify(state.draft_json) : null,
    state.server_order_id ?? null,
    nextRev,
  );
  const status = state.status ?? "ocupada";
  if (status === "livre") {
    publishEvent("mesa.freed", { mesaId: state.mesa_id, revision: nextRev });
  } else {
    publishEvent("mesa.updated", {
      mesaId: state.mesa_id,
      revision: nextRev,
      orderItemsCount: Number(state.order_items_count) || 0,
      orderTotal: Number(state.order_total) || 0,
    });
  }
  return { ok: true, revision: nextRev };
}

function marcarLivreNoSnapshot(mesaId) {
  const id = String(mesaId);
  let revision = 0;
  // Limpa draft local ao liberar — evita pull reocupar com carrinho stale.
  if (db) {
    try {
      const prev = obterLocal(id);
      revision = (prev?.revision || 0) + 1;
      db.prepare(
        `UPDATE mesa_local SET
           status = 'livre',
           closed_for_billing = 0,
           order_total = 0,
           order_items_count = 0,
           draft_json = NULL,
           server_order_id = NULL,
           revision = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE mesa_id = ?`,
      ).run(revision, id);
      if (!prev) {
        // Garante linha sticky livre para revision/SSE mesmo sem local prévio.
        db.prepare(
          `INSERT INTO mesa_local (
             mesa_id, order_id, client_order_number, status, revision, updated_at
           ) VALUES (?, '', '', 'livre', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(mesa_id) DO NOTHING`,
        ).run(id, revision);
      }
    } catch {
      /* ignore */
    }
  }
  const snap = obterSnapshot();
  if (!snap.some((m) => m.id === id)) {
    publishEvent("mesa.freed", { mesaId: id, revision });
    return { ok: true, changed: false, revision };
  }
  salvarSnapshot(
    snap.map((m) =>
      m.id === id
        ? {
            ...m,
            status: "livre",
            open_order_id: null,
            order_total: 0,
            order_items_count: 0,
            closed_for_billing: false,
          }
        : m,
    ),
  );
  publishEvent("mesa.freed", { mesaId: id, revision });
  return { ok: true, changed: true, revision };
}

function removerLocal(mesaId) {
  if (!db) return { ok: true };
  const id = String(mesaId);
  db.prepare(`DELETE FROM mesa_local WHERE mesa_id = ?`).run(id);
  // Snapshot: marca livre para o mapa dos celulares (pós-faturar / liberar).
  marcarLivreNoSnapshot(id);
  return { ok: true };
}

function listarLocal() {
  if (!db) return [];
  return db
    .prepare(`SELECT * FROM mesa_local ORDER BY updated_at DESC`)
    .all()
    .map(rowToLocal);
}

function obterLocal(mesaId) {
  if (!db) return null;
  const row = db.prepare(`SELECT * FROM mesa_local WHERE mesa_id = ?`).get(String(mesaId));
  return row ? rowToLocal(row) : null;
}

function rowToLocal(row) {
  let draft = null;
  if (row.draft_json) {
    try {
      draft = JSON.parse(row.draft_json);
    } catch {
      draft = null;
    }
  }
  return {
    mesa_id: row.mesa_id,
    order_id: row.order_id,
    client_order_number: row.client_order_number,
    mesa_codigo: row.mesa_codigo,
    status: row.status,
    closed_for_billing: !!row.closed_for_billing,
    order_total: row.order_total,
    order_items_count: row.order_items_count,
    draft_json: draft,
    server_order_id: row.server_order_id,
    updated_at: row.updated_at,
    revision: Number(row.revision) || 0,
  };
}

function syncPayloadMetrics(payload) {
  const sync = payload && typeof payload === "object" ? payload.sync || payload : {};
  let items = 0;
  let total = 0;
  if (Array.isArray(sync.items)) {
    items = sync.items.length;
    total = sync.items.reduce(
      (s, i) => s + (Number(i.total) || Number(i.unit_price) * Number(i.quantity) || 0),
      0,
    );
    total = total - (Number(sync.discount) || 0) + (Number(sync.surcharge) || 0);
  } else {
    items = Number(sync.order_items_count) || 0;
    total = Number(sync.order_total ?? sync.total) || 0;
  }
  return { items, total };
}

function enfileirarOp(op) {
  if (!db) throw new Error("MesaFila nao inicializada");
  const id = op.id || `mesa-op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tipo = String(op.tipo || "").toUpperCase();
  if (!["OPEN", "SYNC", "CLOSE", "RELEASE"].includes(tipo)) {
    throw new Error(`tipo de op invalido: ${tipo}`);
  }
  if (!op.mesa_id) throw new Error("mesa_id obrigatorio");

  // Dedup: substitui op pendente do mesmo tipo+mesa (exceto OPEN que é único)
  if (tipo === "SYNC") {
    const existing = db
      .prepare(
        `SELECT * FROM mesa_ops WHERE mesa_id = ? AND tipo = 'SYNC' AND status IN ('PENDENTE','FALHA')`,
      )
      .get(String(op.mesa_id));
    if (existing) {
      let oldPayload = {};
      try {
        oldPayload = JSON.parse(existing.payload || "{}");
      } catch {
        oldPayload = {};
      }
      const oldM = syncPayloadMetrics(oldPayload);
      const newM = syncPayloadMetrics(op.payload || {});
      // Não troca SYNC rico por payload menor (anti-perda na fila).
      if (isSyncShrink(newM.items, newM.total, oldM.items, oldM.total)) {
        return { ok: true, id: existing.id, skipped: "shrink" };
      }
      db.prepare(`DELETE FROM mesa_ops WHERE id = ?`).run(existing.id);
    }
  } else if (tipo !== "OPEN") {
    db.prepare(
      `DELETE FROM mesa_ops WHERE mesa_id = ? AND tipo = ? AND status IN ('PENDENTE','FALHA')`,
    ).run(String(op.mesa_id), tipo);
  } else {
    const existing = db
      .prepare(
        `SELECT id FROM mesa_ops WHERE mesa_id = ? AND tipo = 'OPEN' AND status IN ('PENDENTE','ENVIANDO','FALHA')`,
      )
      .get(String(op.mesa_id));
    if (existing) {
      db.prepare(
        `UPDATE mesa_ops SET payload = ?, status = 'PENDENTE', tentativas = 0, ultimo_erro = NULL WHERE id = ?`,
      ).run(JSON.stringify(op.payload || {}), existing.id);
      return { ok: true, id: existing.id, dedup: true };
    }
  }

  db.prepare(
    `INSERT INTO mesa_ops (id, tipo, mesa_id, payload, status)
     VALUES (?, ?, ?, ?, 'PENDENTE')`,
  ).run(id, tipo, String(op.mesa_id), JSON.stringify(op.payload || {}));
  return { ok: true, id };
}

function listarOps(opts = {}) {
  if (!db) return [];
  const status = opts.status;
  if (status) {
    return db
      .prepare(`SELECT * FROM mesa_ops WHERE status = ? ORDER BY criado_em ASC`)
      .all(status)
      .map(rowToOp);
  }
  return db
    .prepare(`SELECT * FROM mesa_ops ORDER BY criado_em ASC`)
    .all()
    .map(rowToOp);
}

function rowToOp(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    tipo: row.tipo,
    mesa_id: row.mesa_id,
    payload,
    status: row.status,
    tentativas: row.tentativas,
    ultimo_erro: row.ultimo_erro,
    criado_em: row.criado_em,
    sincronizado_em: row.sincronizado_em,
  };
}

function contadores() {
  if (!db) return { pendentes: 0, falhas: 0 };
  const pendentes = db
    .prepare(`SELECT COUNT(*) AS c FROM mesa_ops WHERE status IN ('PENDENTE','ENVIANDO')`)
    .get().c;
  const falhas = db
    .prepare(`SELECT COUNT(*) AS c FROM mesa_ops WHERE status IN ('FALHA','FALHA_PERM')`)
    .get().c;
  return { pendentes, falhas };
}

/**
 * Cancela ops pendentes da mesa.
 * @param {string} mesaId
 * @param {{ keep?: string[] }} [opts] — tipos a preservar (ex.: ['OPEN','SYNC'] no faturar)
 */
function cancelarOpsMesa(mesaId, opts = {}) {
  if (!db || !mesaId) return { ok: true, cancelados: 0 };
  const keep = new Set(
    (Array.isArray(opts.keep) ? opts.keep : []).map((t) => String(t).toUpperCase()),
  );
  let r;
  if (keep.size > 0) {
    const placeholders = [...keep].map(() => "?").join(",");
    r = db
      .prepare(
        `UPDATE mesa_ops SET status = 'CANCELADO',
           sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE mesa_id = ? AND status IN ('PENDENTE','ENVIANDO','FALHA')
           AND tipo NOT IN (${placeholders})`,
      )
      .run(String(mesaId), ...keep);
  } else {
    r = db
      .prepare(
        `UPDATE mesa_ops SET status = 'CANCELADO',
           sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE mesa_id = ? AND status IN ('PENDENTE','ENVIANDO','FALHA')`,
      )
      .run(String(mesaId));
  }
  return { ok: true, cancelados: r.changes };
}

/**
 * client_order_number com OPEN ainda não sincronizado —
 * vendas ORDER-{key} devem aguardar.
 */
function clientKeysComOpenPendente() {
  if (!db) return new Set();
  const rows = db
    .prepare(
      `SELECT payload FROM mesa_ops
       WHERE tipo = 'OPEN' AND status IN ('PENDENTE','ENVIANDO','FALHA')`,
    )
    .all();
  const keys = new Set();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload || "{}");
      if (p.client_order_number) keys.add(String(p.client_order_number));
    } catch {
      /* ignore */
    }
  }
  // Também das mesas locais ainda sem server_order_id
  const locais = listarLocal().filter((l) => l.status === "ocupada" && !l.server_order_id);
  for (const l of locais) {
    if (l.client_order_number) keys.add(String(l.client_order_number));
  }
  return keys;
}

function deveAdiarVendaOrder(numeroVenda) {
  if (!numeroVenda || !String(numeroVenda).toUpperCase().startsWith("ORDER-")) {
    return false;
  }
  const key = String(numeroVenda).slice("ORDER-".length);
  return clientKeysComOpenPendente().has(key);
}

function mesclarSnapshotComLocal() {
  const snapshot = obterSnapshot();
  const locais = listarLocal();
  const byId = new Map(locais.map((l) => [l.mesa_id, l]));
  return snapshot.map((m) => {
    const local = byId.get(m.id);
    if (!local) return m;

    const snapLivre = m.status === "livre" && !m.open_order_id;
    if (snapLivre) {
      const liveConsumo =
        local.status === "ocupada" &&
        !local.closed_for_billing &&
        ((Number(local.order_items_count) || 0) > 0 ||
          (Number(local.order_total) || 0) > 0);
      // Open recente sem itens ainda (race pós-abrir QR) — 120s de graça.
      const updatedMs = Date.parse(local.updated_at || "") || 0;
      const openRecenteVazio =
        local.status === "ocupada" &&
        !local.closed_for_billing &&
        Boolean(local.server_order_id || local.order_id) &&
        Date.now() - updatedMs < 120_000;
      if (!liveConsumo && !openRecenteVazio) {
        return {
          ...m,
          status: "livre",
          open_order_id: null,
          order_total: 0,
          order_items_count: 0,
          closed_for_billing: false,
        };
      }
    }

    if (local.status === "livre" && !local.closed_for_billing) {
      return {
        ...m,
        status: "livre",
        open_order_id: null,
        order_total: 0,
        order_items_count: 0,
        closed_for_billing: false,
      };
    }
    const snapItems = Number(m.order_items_count) || 0;
    const snapTotal = Number(m.order_total) || 0;
    let items = Number(local.order_items_count) || 0;
    let total = Number(local.order_total) || 0;
    // Local 0 + snapshot com itens = open stale (QR/nuvem à frente).
    if (items === 0 && snapItems > 0) {
      items = snapItems;
      total = snapTotal;
    } else if (snapItems > items || snapTotal > total) {
      items = Math.max(items, snapItems);
      total = Math.max(total, snapTotal);
    }
    return {
      ...m,
      status: "ocupada",
      open_order_id: local.server_order_id || local.order_id,
      order_total: total,
      order_items_count: items,
      closed_for_billing: !!(local.closed_for_billing || m.closed_for_billing),
    };
  });
}

async function fetchBackend(method, pathSuffix, body) {
  if (!BACKEND_URL || !BACKEND_TOKEN) {
    throw new Error("Backend nao configurado no agente");
  }
  const base = BACKEND_URL.replace(/\/$/, "");
  const url = `${base}${pathSuffix}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BACKEND_TOKEN}`,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg =
        data?.message || data?.erro || data?.error || text || `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function processarOp(op) {
  const local = obterLocal(op.mesa_id);
  const payload = op.payload || {};

  switch (op.tipo) {
    case "OPEN": {
      const clientOrderNumber =
        payload.client_order_number || local?.client_order_number;
      const data = await fetchBackend("POST", `/order-engine/tables/${op.mesa_id}/open`, {
        client_order_number: clientOrderNumber,
      });
      const serverOrderId = data?.order?.id;
      if (serverOrderId && local) {
        upsertLocal({
          ...local,
          server_order_id: serverOrderId,
          order_id: local.order_id,
          draft_json: local.draft_json,
        });
      }
      return data;
    }
    case "SYNC": {
      const syncBody = payload.sync || payload;
      const items = Array.isArray(syncBody.items) ? syncBody.items : [];
      const proposedItems = items.length;
      const proposedTotal = items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price ?? it.unitPrice) || 0),
        0,
      );
      if (
        local &&
        local.status === "ocupada" &&
        isSyncShrink(
          proposedItems,
          proposedTotal,
          local.order_items_count,
          local.order_total,
        )
      ) {
        const err = new Error(
          `mesa_sync_shrink_blocked: local=${local.order_items_count} proposed=${proposedItems}`,
        );
        err.code = "SHRINK_BLOCKED";
        console.warn("[MesaFila]", err.message, { mesaId: op.mesa_id });
        throw err;
      }
      return fetchBackend("POST", `/order-engine/tables/${op.mesa_id}/sync`, syncBody);
    }
    case "CLOSE": {
      const syncBody = payload.sync || payload;
      return fetchBackend(
        "POST",
        `/order-engine/tables/${op.mesa_id}/close-bill`,
        syncBody,
      );
    }
    case "RELEASE": {
      const data = await fetchBackend(
        "POST",
        `/order-engine/tables/${op.mesa_id}/release`,
        {},
      );
      removerLocal(op.mesa_id);
      return data;
    }
    default:
      throw new Error(`tipo desconhecido: ${op.tipo}`);
  }
}

async function sincronizar() {
  if (syncEmAndamento) return { ok: false, motivo: "sync_em_andamento" };
  if (!db) return { ok: false, motivo: "nao_inicializado" };
  if (!BACKEND_URL || !BACKEND_TOKEN) {
    return { ok: false, motivo: "sem_config" };
  }

  syncEmAndamento = true;
  let ok = 0;
  let falhas = 0;
  try {
    const pendentes = db
      .prepare(
        `SELECT * FROM mesa_ops WHERE status IN ('PENDENTE','FALHA') ORDER BY criado_em ASC LIMIT 50`,
      )
      .all()
      .map(rowToOp);

    for (const op of pendentes) {
      db.prepare(`UPDATE mesa_ops SET status = 'ENVIANDO' WHERE id = ?`).run(op.id);
      try {
        await processarOp(op);
        db.prepare(
          `UPDATE mesa_ops SET status = 'SINCRONIZADO',
             sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             ultimo_erro = NULL
           WHERE id = ?`,
        ).run(op.id);
        ok += 1;
      } catch (err) {
        const msg = err?.message || String(err);
        // Pedido já faturado/cancelado — OPEN residual é no-op de sucesso.
        if (/PEDIDO_OFFLINE_JA_FINALIZADO/i.test(msg)) {
          db.prepare(
            `UPDATE mesa_ops SET status = 'SINCRONIZADO',
               sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               ultimo_erro = ?
             WHERE id = ?`,
          ).run(msg.slice(0, 500), op.id);
          removerLocal(op.mesa_id);
          ok += 1;
          continue;
        }
        const isShrink =
          err?.code === "SHRINK_BLOCKED" ||
          /mesa_sync_shrink_blocked|SHRINK_BLOCKED/i.test(msg);
        // Shrink recorrente: cancela (não ocupa budget da fila pra sempre).
        if (isShrink && Number(op.tentativas || 0) >= 2) {
          db.prepare(
            `UPDATE mesa_ops SET status = 'CANCELADO',
               tentativas = tentativas + 1,
               ultimo_erro = ?
             WHERE id = ?`,
          ).run(msg.slice(0, 500), op.id);
          falhas += 1;
          continue;
        }
        const permanente =
          !isShrink &&
          /já vinculado a outra mesa|não encontrada|nao encontrada|PEDIDO_OFFLINE/i.test(
            msg,
          );
        db.prepare(
          `UPDATE mesa_ops SET status = ?,
             tentativas = tentativas + 1,
             ultimo_erro = ?
           WHERE id = ?`,
        ).run(permanente ? "FALHA_PERM" : "FALHA", msg.slice(0, 500), op.id);
        falhas += 1;
        console.warn(`[MesaFila] Op ${op.tipo} mesa=${op.mesa_id} falhou:`, msg);
      }
    }
    return { ok: true, sincronizados: ok, falhas };
  } finally {
    syncEmAndamento = false;
  }
}

/**
 * Apply path versionado (flag MESA_OPLOG). Dual-write: atualiza mesa_local materializado.
 * @returns {{ status: number, body: object }}
 */
function applyOp(body) {
  if (!db) throw new Error("MesaFila nao inicializada");
  const opId = String(body?.opId || body?.op_id || "").trim();
  const mesaId = String(body?.mesaId || body?.mesa_id || "").trim();
  const type = String(body?.type || body?.tipo || "").toUpperCase();
  const baseRevision = Number(body?.baseRevision ?? body?.base_rev ?? 0);
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  const actor = body?.actor || null;

  if (!opId || !mesaId || !type) {
    return { status: 400, body: { erro: "opId, mesaId e type obrigatorios" } };
  }

  const existingLog = db.prepare(`SELECT * FROM mesa_op_log WHERE op_id = ?`).get(opId);
  if (existingLog) {
    const state = obterLocal(mesaId);
    return {
      status: 200,
      body: {
        revision: existingLog.new_rev,
        state: state || null,
        duplicate: true,
      },
    };
  }

  const current = obterLocal(mesaId);
  const currentRev = current?.revision || 0;

  if (
    (type === "ADD_LINES" || type === "VOID_LINE" || type === "SET_NOTES" || type === "SYNC") &&
    current &&
    current.status === "livre" &&
    !current.closed_for_billing
  ) {
    return {
      status: 409,
      body: { code: "MESA_CLOSED", revision: currentRev, state: current },
    };
  }

  if (baseRevision !== currentRev && type !== "OPEN" && type !== "CLOSE_BILL" && type !== "RELEASE") {
    return {
      status: 409,
      body: {
        code: "STALE_REVISION",
        revision: currentRev,
        state: current || null,
      },
    };
  }

  let nextState;
  if (type === "CLOSE_BILL" || type === "RELEASE") {
    const r = marcarLivreNoSnapshot(mesaId);
    nextState = obterLocal(mesaId);
    db.prepare(
      `INSERT INTO mesa_op_log (op_id, mesa_id, type, payload, base_rev, new_rev, actor_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opId,
      mesaId,
      type,
      JSON.stringify(payload),
      baseRevision,
      r.revision || (currentRev + 1),
      actor ? JSON.stringify(actor) : null,
    );
    // Enfileira RELEASE/CLOSE legado para dreno nuvem
    try {
      enfileirarOp({
        tipo: type === "CLOSE_BILL" ? "CLOSE" : "RELEASE",
        mesa_id: mesaId,
        payload: type === "CLOSE_BILL" ? { sync: payload.sync || payload } : {},
      });
    } catch {
      /* ignore */
    }
    return {
      status: 200,
      body: { revision: r.revision || currentRev + 1, state: nextState },
    };
  }

  if (type === "OPEN") {
    nextState = {
      mesa_id: mesaId,
      order_id: String(payload.order_id || payload.orderId || opId),
      client_order_number: String(
        payload.client_order_number || payload.clientOrderNumber || opId,
      ),
      mesa_codigo: payload.mesa_codigo || payload.mesaCodigo || null,
      status: "ocupada",
      closed_for_billing: false,
      order_total: Number(payload.order_total) || 0,
      order_items_count: Number(payload.order_items_count) || 0,
      draft_json: payload.draft_json || payload.draft || null,
      server_order_id: payload.server_order_id || null,
    };
  } else if (type === "ADD_LINES" || type === "SET_NOTES" || type === "SET_CLOSED_FOR_BILLING" || type === "SYNC") {
    if (!current && type !== "OPEN") {
      return { status: 409, body: { code: "MESA_CLOSED", revision: 0, state: null } };
    }
    const itemsCount =
      payload.order_items_count != null
        ? Number(payload.order_items_count)
        : Array.isArray(payload.items)
          ? payload.items.length
          : current?.order_items_count || 0;
    const orderTotal =
      payload.order_total != null ? Number(payload.order_total) : current?.order_total || 0;
    // Só SYNC (snapshot nuvem/fila) bloqueia shrink.
    // ADD_LINES com revision correta = edição autoritativa (inclui remoção).
    if (
      type === "SYNC" &&
      current &&
      isSyncShrink(itemsCount, orderTotal, current.order_items_count, current.order_total)
    ) {
      return {
        status: 409,
        body: {
          code: "SHRINK_BLOCKED",
          revision: currentRev,
          state: current,
        },
      };
    }
    nextState = {
      mesa_id: mesaId,
      order_id: current?.order_id || String(payload.order_id || opId),
      client_order_number:
        current?.client_order_number || String(payload.client_order_number || opId),
      mesa_codigo: payload.mesa_codigo ?? current?.mesa_codigo ?? null,
      status: "ocupada",
      closed_for_billing:
        type === "SET_CLOSED_FOR_BILLING"
          ? !!payload.closed_for_billing
          : !!current?.closed_for_billing,
      order_total: orderTotal,
      order_items_count: itemsCount,
      draft_json: payload.draft_json ?? payload.draft ?? current?.draft_json ?? null,
      server_order_id: payload.server_order_id ?? current?.server_order_id ?? null,
    };
  } else if (type === "VOID_LINE") {
    if (!current) {
      return { status: 409, body: { code: "MESA_CLOSED", revision: 0, state: null } };
    }
    const itemsCount = Math.max(0, (current.order_items_count || 0) - 1);
    nextState = {
      ...current,
      mesa_id: mesaId,
      order_items_count: itemsCount,
      order_total: Number(payload.order_total) || current.order_total,
      draft_json: payload.draft_json ?? current.draft_json,
    };
  } else {
    return { status: 400, body: { erro: `type invalido: ${type}` } };
  }

  const up = upsertLocal(nextState, {
    allowReopen: type === "OPEN",
    // Edição versionada pode reduzir itens; PUT cego e SYNC não.
    allowShrink:
      type === "VOID_LINE" || type === "ADD_LINES" || type === "SET_NOTES",
  });
  if (up?.ok === false) {
    return {
      status: 409,
      body: {
        code: up.code || "SHRINK_BLOCKED",
        revision: up.revision || currentRev,
        state: up.state || current || null,
      },
    };
  }
  db.prepare(
    `INSERT INTO mesa_op_log (op_id, mesa_id, type, payload, base_rev, new_rev, actor_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opId,
    mesaId,
    type,
    JSON.stringify(payload),
    baseRevision,
    up.revision,
    actor ? JSON.stringify(actor) : null,
  );

  if (type === "OPEN") {
    try {
      enfileirarOp({
        tipo: "OPEN",
        mesa_id: mesaId,
        payload: { client_order_number: nextState.client_order_number },
      });
    } catch {
      /* ignore */
    }
  } else if (type === "SYNC" || type === "ADD_LINES") {
    try {
      if (payload.sync || (type === "SYNC" && payload.items)) {
        enfileirarOp({
          tipo: "SYNC",
          mesa_id: mesaId,
          payload: { sync: payload.sync || payload },
        });
      }
    } catch {
      /* ignore */
    }
  }

  return {
    status: 200,
    body: { revision: up.revision, state: obterLocal(mesaId) },
  };
}

function features() {
  return {
    mesaOplog: isOplogEnabled(),
    sse: true,
    antiShrink: true,
    revision: true,
  };
}

module.exports = {
  inicializar,
  atualizarConfig,
  salvarSnapshot,
  obterSnapshot,
  mesclarSnapshotComLocal,
  upsertLocal,
  removerLocal,
  marcarLivreNoSnapshot,
  listarLocal,
  obterLocal,
  enfileirarOp,
  listarOps,
  contadores,
  cancelarOpsMesa,
  clientKeysComOpenPendente,
  deveAdiarVendaOrder,
  sincronizar,
  applyOp,
  subscribeEvents,
  publishEvent,
  eventsSince,
  isOplogEnabled,
  isSyncShrink,
  features,
};
