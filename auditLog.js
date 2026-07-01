// Audit log imutável — operações sensíveis
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { getDirectoryManager } = require("./runtime/directoryManager");

let db = null;

function dbPath() {
  const p = getDirectoryManager().file("agent", "audit.db");
  getDirectoryManager().ensurePath(path.dirname(p), "agentData");
  return p;
}

function init() {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      ip TEXT,
      criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_acao ON audit_log(acao, criado_em);
  `);
  return db;
}

function registrar(acao, detalhe = null, req = null) {
  init();
  const ip = req?.ip || req?.socket?.remoteAddress || null;
  db.prepare(
    `INSERT INTO audit_log (acao, detalhe, ip) VALUES (?, ?, ?)`,
  ).run(acao, detalhe ? JSON.stringify(detalhe) : null, ip);
}

function listar(limit = 100) {
  init();
  return db
    .prepare(
      `SELECT id, acao, detalhe, ip, criado_em FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

function purgeAntigos(dias = 90) {
  init();
  const limite = Math.max(1, parseInt(dias, 10) || 90);
  const r = db
    .prepare(
      `DELETE FROM audit_log WHERE criado_em < datetime('now', '-' || ? || ' days')`,
    )
    .run(limite);
  return { removidos: r.changes, dias: limite };
}

function close() {
  if (db) {
    try {
      db.close();
    } catch (_) {}
    db = null;
  }
}

module.exports = { init, registrar, listar, purgeAntigos, close };
