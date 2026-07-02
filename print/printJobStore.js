/**
 * Persistência SQLite de jobs de impressão.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { getDirectoryManager } = require("../runtime/directoryManager");
const { STATUS } = require("./printJobTypes");

let db;

function dbPath() {
  return getDirectoryManager().file("agent", "print_jobs.db");
}

function initDb() {
  if (db) return db;
  getDirectoryManager().ensureAll();
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL,
      op TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      payload_json TEXT NOT NULL,
      documento TEXT,
      numero_venda TEXT,
      usuario TEXT,
      caixa TEXT,
      tenant_id TEXT,
      tentativas INTEGER NOT NULL DEFAULT 0,
      max_tentativas INTEGER NOT NULL DEFAULT 5,
      proxima_tentativa_em INTEGER,
      provider TEXT,
      driver TEXT,
      porta TEXT,
      modelo TEXT,
      duracao_ms INTEGER,
      bytes_enviados INTEGER,
      erro TEXT,
      motivo TEXT,
      job_pai_id TEXT,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      impresso_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, proxima_tentativa_em);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_venda ON print_jobs(numero_venda);
    CREATE TABLE IF NOT EXISTS print_job_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      evento TEXT NOT NULL,
      detalhe TEXT,
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_print_eventos_job ON print_job_eventos(job_id);
  `);
  return db;
}

function novoId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function inserirJob(row) {
  const d = initDb();
  d.prepare(
    `INSERT INTO print_jobs (
      id, tipo, op, status, payload_json, documento, numero_venda, usuario, caixa, tenant_id,
      tentativas, max_tentativas, proxima_tentativa_em, motivo, job_pai_id, criado_em, atualizado_em
    ) VALUES (
      @id, @tipo, @op, @status, @payload_json, @documento, @numero_venda, @usuario, @caixa, @tenant_id,
      @tentativas, @max_tentativas, @proxima_tentativa_em, @motivo, @job_pai_id, @criado_em, @atualizado_em
    )`,
  ).run(row);
  return row.id;
}

function registrarEvento(jobId, evento, detalhe) {
  initDb()
    .prepare(
      `INSERT INTO print_job_eventos (job_id, evento, detalhe, criado_em) VALUES (?, ?, ?, ?)`,
    )
    .run(jobId, evento, detalhe ? String(detalhe).slice(0, 500) : null, nowIso());
}

function atualizarJob(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  initDb()
    .prepare(`UPDATE print_jobs SET ${sets}, atualizado_em = @atualizado_em WHERE id = @id`)
    .run({ ...patch, atualizado_em: nowIso(), id });
}

function buscarJob(id) {
  return initDb().prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(id) || null;
}

function proximoJobPronto() {
  const now = Date.now();
  return (
    initDb()
      .prepare(
        `SELECT * FROM print_jobs
         WHERE status IN ('PENDENTE', 'REPROCESSANDO')
           AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= ?)
         ORDER BY criado_em ASC
         LIMIT 1`,
      )
      .get(now) || null
  );
}

function listarJobs(opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 200);
  const status = opts.status ? String(opts.status) : null;
  if (status) {
    return initDb()
      .prepare(
        `SELECT * FROM print_jobs WHERE status = ? ORDER BY criado_em DESC LIMIT ?`,
      )
      .all(status, limit);
  }
  return initDb()
    .prepare(`SELECT * FROM print_jobs ORDER BY criado_em DESC LIMIT ?`)
    .all(limit);
}

function contadores() {
  const rows = initDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM print_jobs GROUP BY status`,
    )
    .all();
  const out = {
    pendente: 0,
    enviando: 0,
    impresso: 0,
    erro: 0,
    reprocessando: 0,
    cancelado: 0,
    total: 0,
  };
  for (const r of rows) {
    const k = String(r.status || "").toLowerCase();
    if (k in out) out[k] = r.n;
    out.total += r.n;
  }
  return out;
}

function ultimoJobImpresso() {
  return (
    initDb()
      .prepare(
        `SELECT * FROM print_jobs WHERE status = 'IMPRESSO' ORDER BY impresso_em DESC LIMIT 1`,
      )
      .get() || null
  );
}

function ultimoJobErro() {
  return (
    initDb()
      .prepare(
        `SELECT * FROM print_jobs WHERE status = 'ERRO' ORDER BY atualizado_em DESC LIMIT 1`,
      )
      .get() || null
  );
}

function tempoMedioMs() {
  const row = initDb()
    .prepare(
      `SELECT AVG(duracao_ms) AS avg FROM print_jobs WHERE status = 'IMPRESSO' AND duracao_ms IS NOT NULL`,
    )
    .get();
  return row?.avg ? Math.round(row.avg) : null;
}

function tempoMaximoMs() {
  const row = initDb()
    .prepare(
      `SELECT MAX(duracao_ms) AS mx FROM print_jobs WHERE status = 'IMPRESSO' AND duracao_ms IS NOT NULL`,
    )
    .get();
  return row?.mx ? Math.round(row.mx) : null;
}

function metricasPorTipo() {
  const rows = initDb()
    .prepare(
      `SELECT tipo, COUNT(*) AS total,
              SUM(CASE WHEN status='IMPRESSO' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status='ERRO' THEN 1 ELSE 0 END) AS erros,
              AVG(CASE WHEN status='IMPRESSO' THEN duracao_ms END) AS tempoMedioMs
       FROM print_jobs GROUP BY tipo ORDER BY total DESC LIMIT 20`,
    )
    .all();
  return rows.map((r) => ({
    tipo: r.tipo,
    total: r.total,
    ok: r.ok,
    erros: r.erros,
    tempoMedioMs: r.tempoMedioMs ? Math.round(r.tempoMedioMs) : null,
  }));
}

function purgeAntigos(dias) {
  const d = Number(dias) || 90;
  const limite = new Date(Date.now() - d * 86400000).toISOString();
  const r = initDb()
    .prepare(
      `DELETE FROM print_jobs WHERE status IN ('IMPRESSO', 'CANCELADO', 'ERRO') AND criado_em < ?`,
    )
    .run(limite);
  initDb()
    .prepare(
      `DELETE FROM print_job_eventos WHERE job_id NOT IN (SELECT id FROM print_jobs)`,
    )
    .run();
  return r.changes || 0;
}

function resetDbForTests() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  STATUS,
  initDb,
  novoId,
  inserirJob,
  registrarEvento,
  atualizarJob,
  buscarJob,
  proximoJobPronto,
  listarJobs,
  contadores,
  ultimoJobImpresso,
  ultimoJobErro,
  tempoMedioMs,
  tempoMaximoMs,
  metricasPorTipo,
  purgeAntigos,
  resetDbForTests,
};
