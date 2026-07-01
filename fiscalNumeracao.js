// Numeração NFC-e — sequência local por série/modelo/dispositivo (multi-caixa).
const path = require("path");
const fs = require("fs");
const { getDirectoryManager } = require("./runtime/directoryManager");

const MODELO_NFCE = "65";
const SERIE_PADRAO = process.env.NFE_SERIE || "1";
const SERIE_NFE_55 = process.env.NFE_SERIE_55 || SERIE_PADRAO;

let db = null;
let sqliteUnavailable = false;

function numeracaoDisabled() {
  return process.env.FISCAL_NUMERACAO_DISABLED === "true" || sqliteUnavailable;
}

function resolveDispositivoId() {
  return (
    process.env.PDV_DISPOSITIVO_ID ||
    process.env.DISPOSITIVO_ID ||
    process.env.pdvId ||
    "_default"
  );
}

function dbPath() {
  if (process.env.FISCAL_NUMERACAO_DB) {
    const p = process.env.FISCAL_NUMERACAO_DB;
    getDirectoryManager().ensurePath(path.dirname(p), "agentData");
    return p;
  }
  const p = getDirectoryManager().file("agent", "fiscal_numeracao.db");
  getDirectoryManager().ensurePath(path.dirname(p), "agentData");
  return p;
}

function migrateSchema(conn) {
  const cols = conn.prepare(`PRAGMA table_info(nfce_numeracao)`).all();
  const hasDisp = cols.some((c) => c.name === "dispositivo_id");
  if (!hasDisp && cols.length > 0) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS nfce_numeracao_v2 (
        serie TEXT NOT NULL,
        modelo TEXT NOT NULL DEFAULT '65',
        dispositivo_id TEXT NOT NULL DEFAULT '_default',
        ultimo_numero INTEGER NOT NULL DEFAULT 0,
        atualizado_em TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (serie, modelo, dispositivo_id)
      );
      INSERT INTO nfce_numeracao_v2 (serie, modelo, dispositivo_id, ultimo_numero, atualizado_em)
        SELECT serie, modelo, '_default', ultimo_numero, atualizado_em FROM nfce_numeracao;
      DROP TABLE nfce_numeracao;
      ALTER TABLE nfce_numeracao_v2 RENAME TO nfce_numeracao;
    `);
  } else if (cols.length === 0) {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS nfce_numeracao (
        serie TEXT NOT NULL,
        modelo TEXT NOT NULL DEFAULT '65',
        dispositivo_id TEXT NOT NULL DEFAULT '_default',
        ultimo_numero INTEGER NOT NULL DEFAULT 0,
        atualizado_em TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (serie, modelo, dispositivo_id)
      );
    `);
  }
}

function init() {
  if (numeracaoDisabled()) return null;
  if (db) return db;
  try {
    const Database = require("better-sqlite3");
    db = new Database(dbPath());
    db.pragma("journal_mode = WAL");
    migrateSchema(db);
    return db;
  } catch (err) {
    sqliteUnavailable = true;
    if (process.env.FISCAL_NUMERACAO_DISABLED === "true") return null;
    throw err;
  }
}

function normalizarSerie(serie) {
  const s = String(serie || SERIE_PADRAO).replace(/\D/g, "") || "1";
  return s.slice(0, 3);
}

function reservarProximoNumero(serie = SERIE_PADRAO, modelo = MODELO_NFCE) {
  const conn = init();
  const disp = resolveDispositivoId();
  if (!conn) {
    const n = parseInt(String(process.env.NFE_NUMERO || Date.now() % 999999), 10) || 1;
    return {
      serie: normalizarSerie(serie),
      numero: n,
      modelo: String(modelo || MODELO_NFCE),
      dispositivoId: disp,
    };
  }
  const s = normalizarSerie(serie);
  const mod = String(modelo || MODELO_NFCE);
  const reservar = conn.transaction(() => {
    const row = conn
      .prepare(
        `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ? AND dispositivo_id = ?`,
      )
      .get(s, mod, disp);
    const proximo = (row?.ultimo_numero || 0) + 1;
    conn
      .prepare(
        `INSERT INTO nfce_numeracao (serie, modelo, dispositivo_id, ultimo_numero, atualizado_em)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(serie, modelo, dispositivo_id) DO UPDATE SET
           ultimo_numero = excluded.ultimo_numero,
           atualizado_em = datetime('now')`,
      )
      .run(s, mod, disp, proximo);
    return proximo;
  });
  return { serie: s, numero: reservar(), modelo: mod, dispositivoId: disp };
}

function sincronizarNumeroAutorizado(serie, numeroRetornado, modelo = MODELO_NFCE) {
  const n = parseInt(String(numeroRetornado || "").replace(/\D/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return;
  const conn = init();
  if (!conn) return;
  const s = normalizarSerie(serie);
  const mod = String(modelo || MODELO_NFCE);
  const disp = resolveDispositivoId();
  const sync = conn.transaction(() => {
    const row = conn
      .prepare(
        `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ? AND dispositivo_id = ?`,
      )
      .get(s, mod, disp);
    const atual = row?.ultimo_numero || 0;
    if (n <= atual) return;
    conn
      .prepare(
        `INSERT INTO nfce_numeracao (serie, modelo, dispositivo_id, ultimo_numero, atualizado_em)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(serie, modelo, dispositivo_id) DO UPDATE SET
           ultimo_numero = excluded.ultimo_numero,
           atualizado_em = datetime('now')`,
      )
      .run(s, mod, disp, n);
  });
  sync();
}

function consultarUltimo(serie = SERIE_PADRAO, modelo = MODELO_NFCE) {
  const conn = init();
  if (!conn) return 0;
  const s = normalizarSerie(serie);
  const mod = String(modelo || MODELO_NFCE);
  const disp = resolveDispositivoId();
  const row = conn
    .prepare(
      `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ? AND dispositivo_id = ?`,
    )
    .get(s, mod, disp);
  return row?.ultimo_numero || 0;
}

module.exports = {
  init,
  reservarProximoNumero,
  sincronizarNumeroAutorizado,
  consultarUltimo,
  resolveDispositivoId,
  SERIE_PADRAO,
  SERIE_NFE_55,
  MODELO_NFCE,
  MODELO_NFE: "55",
};
