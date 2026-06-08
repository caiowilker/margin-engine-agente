// ============================================================
// PDV Margin Engine — Módulo de Fila Offline com SQLite v3.0
//
// NOVIDADES v3.0:
//   ✓ atualizarConfig() — recebe novo token/url após ativação sem reiniciar
//   ✓ Configuração via config.json (priority) ou process.env (fallback)
//   ✓ Resto igual v2: WAL, idempotência, lote de 50, MAX_TENTATIVAS
// ============================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// ── Configuração ──────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "fila.db");
const MAX_TENTATIVAS = parseInt(process.env.MAX_TENTATIVAS || "10");
const TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || "5000");

// Carregadas dinamicamente (podem ser atualizadas por atualizarConfig)
let BACKEND_URL = process.env.BACKEND_URL || "";
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";

let db;

// ── Atualizar config sem reiniciar (chamado após ativação) ────────────────────
function atualizarConfig(url, token) {
  BACKEND_URL = url;
  BACKEND_TOKEN = token;
  process.env.BACKEND_URL = url;
  process.env.BACKEND_TOKEN = token;
  console.log(`[Fila] Config atualizada — backend: ${url}`);
}

// ── Inicialização do banco ────────────────────────────────────────────────────
function inicializar() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  db.exec(`
    CREATE TABLE IF NOT EXISTS fila_vendas (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_venda    TEXT    NOT NULL UNIQUE,
      payload         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'PENDENTE',
      tentativas      INTEGER NOT NULL DEFAULT 0,
      ultimo_erro     TEXT,
      criado_em       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      sincronizado_em TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_fila_status
      ON fila_vendas(status);

    CREATE INDEX IF NOT EXISTS idx_fila_numero_venda
      ON fila_vendas(numero_venda);
  `);

  console.log(`[Fila SQLite] Banco iniciado em ${DB_PATH}`);
}

// ── Enfileirar venda ──────────────────────────────────────────────────────────
function enfileirar(payload) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO fila_vendas (numero_venda, payload)
    VALUES (?, ?)
  `);
  stmt.run(payload.numeroVenda, JSON.stringify(payload));
}

// ── Tentar backend diretamente ────────────────────────────────────────────────
async function tentarBackend(payload) {
  if (!BACKEND_URL || !BACKEND_TOKEN) {
    return { ok: false, erro: "Agente não configurado — ative primeiro." };
  }

  // node-fetch v2 (CommonJS)
  const fetch = require("node-fetch");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${BACKEND_URL}/pdv/vendas`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BACKEND_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const texto = await resp.text().catch(() => `HTTP ${resp.status}`);
      return { ok: false, erro: texto };
    }

    const dados = await resp.json();
    return { ok: true, dados };
  } catch (err) {
    clearTimeout(timer);
    const motivo = err.name === "AbortError" ? "Timeout" : err.message;
    return { ok: false, erro: motivo };
  }
}

// ── Sincronizar pendentes com o backend ───────────────────────────────────────
async function sincronizar() {
  if (!BACKEND_URL || !BACKEND_TOKEN) {
    return { sincronizadas: 0, falhas: 0 };
  }

  const fetch = require("node-fetch");

  const pendentes = db
    .prepare(
      `
    SELECT id, numero_venda, payload, tentativas
    FROM   fila_vendas
    WHERE  status = 'PENDENTE'
    ORDER  BY id
    LIMIT  50
  `,
    )
    .all();

  if (pendentes.length === 0) return { sincronizadas: 0, falhas: 0 };

  const lote = pendentes.map((row) => JSON.parse(row.payload));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS * 3);

  let respostas;
  try {
    const resp = await fetch(`${BACKEND_URL}/pdv/vendas/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BACKEND_TOKEN}`,
      },
      body: JSON.stringify(lote),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const erro = await resp.text().catch(() => `HTTP ${resp.status}`);
      registrarFalhaLote(pendentes, erro);
      return { sincronizadas: 0, falhas: pendentes.length };
    }

    respostas = await resp.json();
  } catch (err) {
    clearTimeout(timer);
    const motivo = err.name === "AbortError" ? "Timeout" : err.message;
    registrarFalhaLote(pendentes, motivo);
    return { sincronizadas: 0, falhas: pendentes.length };
  }

  let sincronizadas = 0;
  let falhas = 0;

  const marcarSincronizado = db.prepare(`
    UPDATE fila_vendas
    SET    status = 'SINCRONIZADO',
           sincronizado_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE  numero_venda = ?
  `);

  const marcarFalha = db.prepare(`
    UPDATE fila_vendas
    SET    tentativas  = tentativas + 1,
           ultimo_erro = ?,
           status      = CASE
                           WHEN tentativas + 1 >= ${MAX_TENTATIVAS} THEN 'FALHA_PERMANENTE'
                           ELSE 'PENDENTE'
                         END
    WHERE  numero_venda = ?
  `);

  const processarLote = db.transaction((resps) => {
    for (const r of resps) {
      if (r.status === "ok" || r.status === "duplicata") {
        marcarSincronizado.run(r.numeroVenda);
        sincronizadas++;
      } else {
        marcarFalha.run(r.erro || "Erro desconhecido", r.numeroVenda);
        falhas++;
      }
    }
  });

  processarLote(respostas);
  return { sincronizadas, falhas };
}

// ── Helpers internos ──────────────────────────────────────────────────────────
function registrarFalhaLote(pendentes, erro) {
  const stmt = db.prepare(`
    UPDATE fila_vendas
    SET    tentativas  = tentativas + 1,
           ultimo_erro = ?,
           status      = CASE
                           WHEN tentativas + 1 >= ${MAX_TENTATIVAS} THEN 'FALHA_PERMANENTE'
                           ELSE 'PENDENTE'
                         END
    WHERE  id = ?
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run(erro, row.id);
  });
  tx(pendentes);
}

// ── Consultas ─────────────────────────────────────────────────────────────────
function contadores() {
  const row = db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN status = 'PENDENTE'         THEN 1 ELSE 0 END) AS pendentes,
      SUM(CASE WHEN status = 'FALHA_PERMANENTE' THEN 1 ELSE 0 END) AS falhas
    FROM fila_vendas
  `,
    )
    .get();
  return {
    pendentes: row.pendentes || 0,
    falhas: row.falhas || 0,
  };
}

function listar() {
  return db
    .prepare(
      `
    SELECT id, numero_venda, status, tentativas, ultimo_erro, criado_em, sincronizado_em
    FROM   fila_vendas
    ORDER  BY id DESC
    LIMIT  200
  `,
    )
    .all();
}

module.exports = {
  inicializar,
  atualizarConfig, // ← novo
  enfileirar,
  tentarBackend,
  sincronizar,
  contadores,
  listar,
};
