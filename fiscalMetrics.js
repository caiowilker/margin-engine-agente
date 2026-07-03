// Métricas fiscais persistentes (SQLite)
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { getDirectoryManager } = require("./runtime/directoryManager");

const MAX_SAMPLES = parseInt(process.env.FISCAL_METRICS_SAMPLES || "2000", 10);

let db = null;
const memSamples = { emissionMs: [], acbrMs: [], sefazMs: [], callbackMs: [], pdfMs: [] };
const CSTAT_999_WINDOW_MIN = parseInt(process.env.CSTAT_999_RATE_WINDOW_MIN || "10", 10);

const counters = {
  enfileiradas: 0,
  autorizadas: 0,
  recuperadas: 0,
  falhas: 0,
  falhasTemporarias: 0,
  timeouts: 0,
  pdfGerados: 0,
  rateLimitBloqueios: 0,
  rejeicoesPorCStat: {},
  emissoesPorCStat: {},
};
let ultimaAutorizacaoEm = null;

function dbPath() {
  if (process.env.FISCAL_METRICS_DB) return process.env.FISCAL_METRICS_DB;
  const p = getDirectoryManager().file("agent", "fiscal_metrics.db");
  getDirectoryManager().ensurePath(path.dirname(p), "agentData");
  return p;
}

function init() {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      valor_ms REAL NOT NULL,
      meta TEXT,
      criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_metric_tipo ON metric_samples(tipo, criado_em);
    CREATE TABLE IF NOT EXISTS metric_counters (
      chave TEXT PRIMARY KEY,
      valor INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT DEFAULT (datetime('now'))
    );
  `);
  const rows = db.prepare(`SELECT chave, valor FROM metric_counters`).all();
  rows.forEach((r) => {
    if (r.chave.startsWith("emit_cStat:")) {
      counters.emissoesPorCStat[r.chave.slice(11)] = r.valor;
    } else if (r.chave.startsWith("cStat:")) {
      counters.rejeicoesPorCStat[r.chave.slice(6)] = r.valor;
      if (!counters.emissoesPorCStat[r.chave.slice(6)]) {
        counters.emissoesPorCStat[r.chave.slice(6)] = r.valor;
      }
    } else if (Object.prototype.hasOwnProperty.call(counters, r.chave)) {
      counters[r.chave] = r.valor;
    }
  });
  return db;
}

function bumpCounter(chave, delta = 1) {
  init();
  db.prepare(
    `INSERT INTO metric_counters (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = valor + excluded.valor, atualizado_em = datetime('now')`,
  ).run(chave, delta);
}

function pushSample(tipo, value, meta = null) {
  if (!Number.isFinite(value)) return;
  init();
  db.prepare(
    `INSERT INTO metric_samples (tipo, valor_ms, meta) VALUES (?, ?, ?)`,
  ).run(tipo, value, meta ? JSON.stringify(meta) : null);
  const arr = memSamples[`${tipo}Ms`] || memSamples.emissionMs;
  if (Array.isArray(arr)) {
    arr.push(value);
    if (arr.length > MAX_SAMPLES) arr.shift();
  }
  const total = db.prepare(`SELECT COUNT(*) as n FROM metric_samples`).get().n;
  if (total > MAX_SAMPLES * 5) {
    db.prepare(
      `DELETE FROM metric_samples WHERE id IN (
         SELECT id FROM metric_samples ORDER BY id ASC LIMIT ?
       )`,
    ).run(Math.floor(MAX_SAMPLES));
  }
}

function percentileFromDb(tipo, p) {
  init();
  const rows = db
    .prepare(
      `SELECT valor_ms FROM metric_samples WHERE tipo = ? ORDER BY valor_ms ASC LIMIT ?`,
    )
    .all(tipo, MAX_SAMPLES);
  if (!rows.length) return null;
  const idx = Math.ceil((p / 100) * rows.length) - 1;
  return rows[Math.max(0, idx)].valor_ms;
}

function percentile(arr, p) {
  if (!arr?.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function registrarEnfileirada() {
  counters.enfileiradas++;
  bumpCounter("enfileiradas");
}

function registrarCStat(cStat) {
  const cs = String(cStat || "unknown");
  counters.emissoesPorCStat[cs] = (counters.emissoesPorCStat[cs] || 0) + 1;
  bumpCounter(`emit_cStat:${cs}`);
}

function registrarEmissao(durationMs, meta = {}) {
  const sampleMeta = { ...meta };
  if (meta.cStat) {
    sampleMeta.cStat = String(meta.cStat);
  } else if (meta.ok) {
    sampleMeta.cStat = "100";
  } else if (meta.falha) {
    sampleMeta.cStat = String(meta.cStat || "unknown");
  }
  if (Number.isFinite(durationMs)) pushSample("emission", durationMs, sampleMeta);
  if (Number.isFinite(meta.acbrMs)) pushSample("acbr", meta.acbrMs);
  if (Number.isFinite(meta.sefazMs)) pushSample("sefaz", meta.sefazMs);
  if (Number.isFinite(meta.callbackMs)) pushSample("callback", meta.callbackMs);
  if (Number.isFinite(meta.pdfMs)) pushSample("pdf", meta.pdfMs);
  if (meta.ok) {
    counters.autorizadas++;
    bumpCounter("autorizadas");
    ultimaAutorizacaoEm = new Date().toISOString();
    registrarCStat(meta.cStat || "100");
  }
  if (meta.recuperada) {
    counters.recuperadas++;
    bumpCounter("recuperadas");
  }
  if (meta.falha) {
    counters.falhas++;
    bumpCounter("falhas");
    const cs = String(meta.cStat || "unknown");
    counters.rejeicoesPorCStat[cs] = (counters.rejeicoesPorCStat[cs] || 0) + 1;
    bumpCounter(`cStat:${cs}`);
    registrarCStat(cs);
  }
  if (meta.falhaTemporaria) {
    counters.falhasTemporarias++;
    bumpCounter("falhasTemporarias");
  }
  if (meta.timeout) {
    counters.timeouts++;
    bumpCounter("timeouts");
  }
  if (meta.pdf) {
    counters.pdfGerados++;
    bumpCounter("pdfGerados");
  }
  if (meta.rateLimit) {
    counters.rateLimitBloqueios++;
    bumpCounter("rateLimitBloqueios");
  }
}

function contarCStatNaJanela(cStat, minutos = CSTAT_999_WINDOW_MIN) {
  init();
  const cs = String(cStat);
  const mins = Math.max(1, parseInt(minutos, 10) || CSTAT_999_WINDOW_MIN);
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM metric_samples
       WHERE tipo = 'emission'
         AND json_extract(meta, '$.cStat') = ?
         AND datetime(criado_em) >= datetime('now', '-' || ? || ' minutes')`,
    )
    .get(cs, mins);
  return row?.n || 0;
}

function snapshot(filaStatus = {}) {
  init();
  const pendentes = filaStatus.pendentes || 0;
  const processando = filaStatus.processando || 0;
  const cStat999Janela = contarCStatNaJanela("999", CSTAT_999_WINDOW_MIN);
  return {
    contadores: {
      ...counters,
      rejeicoesPorCStat: { ...counters.rejeicoesPorCStat },
      emissoesPorCStat: { ...counters.emissoesPorCStat },
    },
    cStat999Janela: {
      janelaMinutos: CSTAT_999_WINDOW_MIN,
      contagem: cStat999Janela,
    },
    latenciaMs: {
      p50: percentileFromDb("emission", 50) ?? percentile(memSamples.emissionMs, 50),
      p95: percentileFromDb("emission", 95) ?? percentile(memSamples.emissionMs, 95),
      p99: percentileFromDb("emission", 99) ?? percentile(memSamples.emissionMs, 99),
    },
    acbrMs: {
      p50: percentileFromDb("acbr", 50),
      p95: percentileFromDb("acbr", 95),
    },
    sefazMs: {
      p50: percentileFromDb("sefaz", 50),
      p95: percentileFromDb("sefaz", 95),
    },
    callbackMs: { p50: percentileFromDb("callback", 50) },
    pdfMs: { p50: percentileFromDb("pdf", 50) },
    taxaSucesso:
      counters.autorizadas + counters.falhas > 0
        ? Math.round(
            (counters.autorizadas / (counters.autorizadas + counters.falhas)) * 1000,
          ) / 10
        : null,
    ultimaAutorizacaoEm,
    fila: filaStatus,
    lag: pendentes + processando + (filaStatus.incerto || 0),
    throughputPorHora: calcularThroughput(),
  };
}

function calcularThroughput() {
  init();
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM metric_samples
       WHERE tipo = 'emission' AND datetime(criado_em) >= datetime('now', '-1 hour')`,
    )
    .get();
  return row?.n || 0;
}

function emissoesHoje() {
  init();
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM metric_samples
       WHERE tipo = 'emission' AND date(criado_em) = date('now')`,
    )
    .get();
  return row?.n || 0;
}

function taxaSucessoPercent() {
  init();
  const total = counters.autorizadas + counters.falhas;
  if (total <= 0) return 0;
  return Math.round((counters.autorizadas / total) * 1000) / 10;
}

/**
 * Registra um bloqueio por rate-limit de UF (token-bucket).
 * Distinto de `rateLimitBloqueios` (que é por CNPJ/min/hora).
 *
 * @param {string} uf - Sigla da UF bloqueada
 */
function registrarBloqueioUf(uf) {
  const key = `rateLimitUf:${String(uf || "XX").toUpperCase()}`;
  if (!counters.rateLimitUfBloqueios) counters.rateLimitUfBloqueios = {};
  const u = String(uf || "XX").toUpperCase();
  counters.rateLimitUfBloqueios[u] = (counters.rateLimitUfBloqueios[u] || 0) + 1;
  bumpCounter(key);
}

function close() {
  if (db) {
    try {
      db.close();
    } catch (_) {}
    db = null;
  }
}

function getDb() {
  init();
  return db;
}

module.exports = {
  init,
  registrarEnfileirada,
  registrarEmissao,
  registrarBloqueioUf,
  contarCStatNaJanela,
  snapshot,
  emissoesHoje,
  taxaSucessoPercent,
  getDb,
  close,
  CSTAT_999_WINDOW_MIN,
};
