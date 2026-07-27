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
const TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || "15000", 10);

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
  `);

  db.prepare(
    `UPDATE mesa_ops SET status = 'PENDENTE' WHERE status = 'ENVIANDO'`,
  ).run();

  console.log("[MesaFila] Tabelas de mesas offline prontas");
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

function upsertLocal(state) {
  if (!db) throw new Error("MesaFila nao inicializada");
  if (!state?.mesa_id || !state?.order_id || !state?.client_order_number) {
    throw new Error("mesa_id, order_id e client_order_number obrigatorios");
  }
  db.prepare(
    `INSERT INTO mesa_local (
       mesa_id, order_id, client_order_number, mesa_codigo, status,
       closed_for_billing, order_total, order_items_count, draft_json, server_order_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(mesa_id) DO UPDATE SET
       order_id = excluded.order_id,
       client_order_number = excluded.client_order_number,
       mesa_codigo = excluded.mesa_codigo,
       status = excluded.status,
       closed_for_billing = excluded.closed_for_billing,
       order_total = excluded.order_total,
       order_items_count = excluded.order_items_count,
       draft_json = excluded.draft_json,
       server_order_id = COALESCE(excluded.server_order_id, mesa_local.server_order_id),
       updated_at = excluded.updated_at`,
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
  );
  return { ok: true };
}

function removerLocal(mesaId) {
  if (!db) return { ok: true };
  db.prepare(`DELETE FROM mesa_local WHERE mesa_id = ?`).run(String(mesaId));
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
  };
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
  if (tipo !== "OPEN") {
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
    return {
      ...m,
      status: "ocupada",
      open_order_id: local.server_order_id || local.order_id,
      order_total: local.order_total,
      order_items_count: local.order_items_count,
      closed_for_billing: !!local.closed_for_billing,
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
        const permanente =
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

module.exports = {
  inicializar,
  atualizarConfig,
  salvarSnapshot,
  obterSnapshot,
  mesclarSnapshotComLocal,
  upsertLocal,
  removerLocal,
  listarLocal,
  obterLocal,
  enfileirarOp,
  listarOps,
  contadores,
  cancelarOpsMesa,
  clientKeysComOpenPendente,
  deveAdiarVendaOrder,
  sincronizar,
};
