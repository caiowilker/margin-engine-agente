// Numeração NFC-e — ACBr não expõe ProximoNumero; o agente reserva sequência local (sincronizada pós-emissão).
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const MODELO = "65";
const SERIE_PADRAO = process.env.NFE_SERIE || "1";

let db = null;

function dbPath() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "fiscal_numeracao.db");
}

function init() {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfce_numeracao (
      serie TEXT NOT NULL,
      modelo TEXT NOT NULL DEFAULT '65',
      ultimo_numero INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (serie, modelo)
    );
  `);
  return db;
}

function normalizarSerie(serie) {
  const s = String(serie || SERIE_PADRAO).replace(/\D/g, "") || "1";
  return s.slice(0, 3);
}

/** Reserva o próximo nNF para a série (transação atômica). */
function reservarProximoNumero(serie = SERIE_PADRAO) {
  init();
  const s = normalizarSerie(serie);
  const reservar = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ?`,
      )
      .get(s, MODELO);
    const proximo = (row?.ultimo_numero || 0) + 1;
    db.prepare(
      `INSERT INTO nfce_numeracao (serie, modelo, ultimo_numero, atualizado_em)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(serie, modelo) DO UPDATE SET
         ultimo_numero = excluded.ultimo_numero,
         atualizado_em = datetime('now')`,
    ).run(s, MODELO, proximo);
    return proximo;
  });
  return { serie: s, numero: reservar(), modelo: MODELO };
}

/** Sincroniza contador local se ACBr retornou número maior (evita 539). */
function sincronizarNumeroAutorizado(serie, numeroRetornado) {
  const n = parseInt(String(numeroRetornado || "").replace(/\D/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return;
  init();
  const s = normalizarSerie(serie);
  const sync = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ?`,
      )
      .get(s, MODELO);
    const atual = row?.ultimo_numero || 0;
    if (n <= atual) return;
    db.prepare(
      `INSERT INTO nfce_numeracao (serie, modelo, ultimo_numero, atualizado_em)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(serie, modelo) DO UPDATE SET
         ultimo_numero = excluded.ultimo_numero,
         atualizado_em = datetime('now')`,
    ).run(s, MODELO, n);
  });
  sync();
}

function consultarUltimo(serie = SERIE_PADRAO) {
  init();
  const s = normalizarSerie(serie);
  const row = db
    .prepare(
      `SELECT ultimo_numero FROM nfce_numeracao WHERE serie = ? AND modelo = ?`,
    )
    .get(s, MODELO);
  return row?.ultimo_numero || 0;
}

module.exports = {
  init,
  reservarProximoNumero,
  sincronizarNumeroAutorizado,
  consultarUltimo,
  SERIE_PADRAO,
};
