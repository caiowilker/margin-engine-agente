// ============================================================
// PDV Margin Engine — Modulo de Fila Offline com SQLite v3.1
//
// v3.1 — Estabilidade
//   - Carrega config.json no startup (token persistido apos ativacao)
//   - numeroVendaCliente aceito como chave de idempotencia
//   - Mutex evita sync simultaneo
//   - contadores/listar tolerantes a falhas
// ============================================================

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "fila.db");
const CONFIG_PATH = path.join(__dirname, "data", "config.json");
const MAX_TENTATIVAS = parseInt(process.env.MAX_TENTATIVAS || "10", 10);
const TIMEOUT_MS = parseInt(process.env.BACKEND_TIMEOUT_MS || "5000", 10);

let BACKEND_URL = process.env.BACKEND_URL || "";
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || "";
let db;
let syncEmAndamento = false;

function extrairNumeroVenda(payload) {
  return (
    payload?.numeroVendaCliente ||
    payload?.numeroVenda ||
    payload?.numero ||
    null
  );
}

function carregarConfigPersistida() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.backendUrl) BACKEND_URL = cfg.backendUrl;
    if (cfg.backendToken) BACKEND_TOKEN = cfg.backendToken;
  } catch (err) {
    console.warn("[Fila] Falha ao ler config.json:", err.message);
  }
}

function atualizarConfig(url, token) {
  BACKEND_URL = url || "";
  BACKEND_TOKEN = token || "";
  if (url) process.env.BACKEND_URL = url;
  if (token) process.env.BACKEND_TOKEN = token;
  console.log(`[Fila] Config atualizada — backend: ${url}`);
}

function inicializar() {
  carregarConfigPersistida();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("busy_timeout = 5000");

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

function enfileirar(payload) {
  if (!db) throw new Error("Fila SQLite nao inicializada.");
  const numero = extrairNumeroVenda(payload);
  if (!numero)
    throw new Error("numeroVendaCliente obrigatorio para enfileirar.");

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO fila_vendas (numero_venda, payload)
    VALUES (?, ?)
  `);
  stmt.run(String(numero), JSON.stringify(payload));
}

async function tentarBackend(payload) {
  const url = BACKEND_URL || process.env.BACKEND_URL || "";
  const token = BACKEND_TOKEN || process.env.BACKEND_TOKEN || "";
  if (!url || !token) {
    return { ok: false, erro: "Agente nao configurado — ative primeiro." };
  }

  const fetch = require("node-fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${url}/pdv/vendas`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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

async function sincronizar() {
  if (syncEmAndamento) {
    return { sincronizadas: 0, falhas: 0, emAndamento: true };
  }

  const url = BACKEND_URL || process.env.BACKEND_URL || "";
  const token = BACKEND_TOKEN || process.env.BACKEND_TOKEN || "";
  if (!url || !token || !db) {
    return { sincronizadas: 0, falhas: 0 };
  }

  syncEmAndamento = true;
  try {
    return await sincronizarInterno(url, token);
  } finally {
    syncEmAndamento = false;
  }
}

async function sincronizarInterno(url, token) {
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
    const resp = await fetch(`${url}/pdv/vendas/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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
      const numero =
        r.numeroVenda || r.numeroVendaCliente || r.numero_venda || null;
      if (!numero) {
        falhas++;
        continue;
      }
      if (r.status === "ok" || r.status === "duplicata") {
        marcarSincronizado.run(String(numero));
        sincronizadas++;
      } else {
        marcarFalha.run(r.erro || "Erro desconhecido", String(numero));
        falhas++;
      }
    }
  });

  processarLote(Array.isArray(respostas) ? respostas : []);
  return { sincronizadas, falhas };
}

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

function contadores() {
  try {
    if (!db) return { pendentes: 0, falhas: 0 };
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
      pendentes: row?.pendentes || 0,
      falhas: row?.falhas || 0,
    };
  } catch (err) {
    console.warn("[Fila] Erro ao ler contadores:", err.message);
    return { pendentes: 0, falhas: 0 };
  }
}

function listar() {
  try {
    if (!db) return [];
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
  } catch (err) {
    console.warn("[Fila] Erro ao listar fila:", err.message);
    return [];
  }
}

/**
 * Reseta itens FALHA_PERMANENTE de volta para PENDENTE para nova tentativa.
 * Opcionalmente recebe um array de numero_venda para resetar apenas itens específicos.
 */
function resetarFalhas(numeros) {
  try {
    if (!db) return { resetados: 0 };
    let stmt;
    let result;
    if (numeros && numeros.length > 0) {
      const placeholders = numeros.map(() => "?").join(",");
      stmt = db.prepare(`
        UPDATE fila_vendas
        SET    status     = 'PENDENTE',
               tentativas = 0,
               ultimo_erro = NULL
        WHERE  status = 'FALHA_PERMANENTE'
        AND    numero_venda IN (${placeholders})
      `);
      result = stmt.run(...numeros.map(String));
    } else {
      stmt = db.prepare(`
        UPDATE fila_vendas
        SET    status     = 'PENDENTE',
               tentativas = 0,
               ultimo_erro = NULL
        WHERE  status = 'FALHA_PERMANENTE'
      `);
      result = stmt.run();
    }
    console.log(`[Fila] ${result.changes} item(s) resetado(s) para PENDENTE.`);
    return { resetados: result.changes };
  } catch (err) {
    console.warn("[Fila] Erro ao resetar falhas:", err.message);
    return { resetados: 0 };
  }
}

module.exports = {
  inicializar,
  atualizarConfig,
  enfileirar,
  tentarBackend,
  sincronizar,
  contadores,
  listar,
  resetarFalhas,
};
