/**
 * Fila local de NFC-e off-line — um processo de agente = um terminal = um fila.db.
 * WAL + BEGIN IMMEDIATE + claim com lock de sync evitam XML perdido/duplicado.
 */
const crypto = require("crypto");
const fiscalDhEmiIni = require("./fiscalDhEmiIni");
const { terminalId } = require("./contingenciaOffline");

let db = null;

function bind(database) {
  db = database;
  ensureSchema();
}

function ensureSchema() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfce_offline_pendentes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chave           TEXT    NOT NULL UNIQUE,
      numero_nfe      TEXT,
      serie           TEXT,
      xml_path        TEXT    NOT NULL,
      numero_venda    TEXT,
      status          TEXT    NOT NULL DEFAULT 'PENDENTE',
      tentativas      INTEGER NOT NULL DEFAULT 0,
      ultimo_erro     TEXT,
      protocolo       TEXT,
      terminal_id     TEXT,
      dh_cont         TEXT,
      sync_token      TEXT,
      sync_lock_until INTEGER,
      criado_em       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nfce_offline_status ON nfce_offline_pendentes(status);
    CREATE TABLE IF NOT EXISTS nfce_offline_janela (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      dh_cont    TEXT NOT NULL,
      aberta_em  TEXT NOT NULL,
      fechada_em TEXT
    );
  `);
  const cols = db.prepare(`PRAGMA table_info(nfce_offline_pendentes)`).all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE nfce_offline_pendentes ADD COLUMN ${ddl}`);
  };
  add("protocolo", "protocolo TEXT");
  add("terminal_id", "terminal_id TEXT");
  add("dh_cont", "dh_cont TEXT");
  add("sync_token", "sync_token TEXT");
  add("sync_lock_until", "sync_lock_until INTEGER");
}

function withImmediate(fn) {
  if (!db) throw new Error("[ContingenciaOffline] fila SQLite não inicializada");
  const trx = db.transaction(fn);
  if (typeof trx.immediate === "function") return trx.immediate();
  return trx();
}

function enqueue(row) {
  ensureSchema();
  const chave = String(row.chave || "").replace(/\D/g, "");
  if (chave.length !== 44) {
    throw new Error("[ContingenciaOffline] enqueue exige chave de 44 dígitos");
  }
  if (!row.xmlPath) {
    throw new Error("[ContingenciaOffline] enqueue exige xmlPath já gravado em disco");
  }
  withImmediate(() => {
    db.prepare(
      `INSERT INTO nfce_offline_pendentes
        (chave, numero_nfe, serie, xml_path, numero_venda, status, terminal_id, dh_cont)
       VALUES (@chave, @numero_nfe, @serie, @xml_path, @numero_venda, 'PENDENTE', @terminal_id, @dh_cont)
       ON CONFLICT(chave) DO UPDATE SET
         xml_path=excluded.xml_path,
         numero_nfe=excluded.numero_nfe,
         serie=excluded.serie,
         status=CASE
           WHEN nfce_offline_pendentes.status='TRANSMITIDO' THEN nfce_offline_pendentes.status
           ELSE 'PENDENTE'
         END,
         ultimo_erro=NULL,
         dh_cont=COALESCE(excluded.dh_cont, nfce_offline_pendentes.dh_cont),
         terminal_id=excluded.terminal_id`,
    ).run({
      chave,
      numero_nfe: row.numero != null ? String(row.numero) : null,
      serie: row.serie != null ? String(row.serie) : null,
      xml_path: String(row.xmlPath),
      numero_venda: row.numeroVenda != null ? String(row.numeroVenda) : null,
      terminal_id: row.terminalId || terminalId(),
      dh_cont: row.dhCont || null,
    });
  });
}

function listPendentes(limit = 20) {
  if (!db) return [];
  ensureSchema();
  return db
    .prepare(
      `SELECT * FROM nfce_offline_pendentes WHERE status='PENDENTE' ORDER BY id LIMIT ?`,
    )
    .all(Math.max(1, Number(limit) || 20));
}

/**
 * Claim atômico para um ciclo de sync (evita dois processos no mesmo XML).
 */
function claimPendentes(limit = 10, ttlMs = 120000) {
  if (!db) return { token: null, rows: [] };
  ensureSchema();
  const token = crypto.randomBytes(12).toString("hex");
  const until = Date.now() + Math.max(30_000, ttlMs);
  const now = Date.now();
  const rows = withImmediate(() => {
    db.prepare(
      `UPDATE nfce_offline_pendentes
       SET sync_token = ?, sync_lock_until = ?
       WHERE id IN (
         SELECT id FROM nfce_offline_pendentes
         WHERE status = 'PENDENTE'
           AND (sync_lock_until IS NULL OR sync_lock_until < ?)
         ORDER BY id
         LIMIT ?
       )`,
    ).run(token, until, now, Math.max(1, Number(limit) || 10));
    return db
      .prepare(
        `SELECT * FROM nfce_offline_pendentes WHERE sync_token = ? AND status = 'PENDENTE'`,
      )
      .all(token);
  });
  return { token, rows };
}

function marcarTransmitido(chave, protocolo) {
  if (!db) return;
  withImmediate(() => {
    db.prepare(
      `UPDATE nfce_offline_pendentes
       SET status='TRANSMITIDO', ultimo_erro=NULL, protocolo=?, sync_token=NULL, sync_lock_until=NULL
       WHERE chave=?`,
    ).run(protocolo != null ? String(protocolo) : null, String(chave).replace(/\D/g, ""));
  });
}

function marcarFalhaRede(chave, erro) {
  if (!db) return;
  withImmediate(() => {
    db.prepare(
      `UPDATE nfce_offline_pendentes
       SET tentativas = tentativas + 1, ultimo_erro=?, sync_token=NULL, sync_lock_until=NULL
       WHERE chave=? AND status='PENDENTE'`,
    ).run(String(erro || "").slice(0, 500), String(chave).replace(/\D/g, ""));
  });
}

function marcarRejeicao(chave, erro, cStat) {
  if (!db) return;
  withImmediate(() => {
    db.prepare(
      `UPDATE nfce_offline_pendentes
       SET tentativas = tentativas + 1,
           ultimo_erro=?,
           status='FALHA_PERMANENTE',
           sync_token=NULL,
           sync_lock_until=NULL
       WHERE chave=? AND status='PENDENTE'`,
    ).run(
      `cStat=${cStat || "?"} ${String(erro || "").slice(0, 450)}`,
      String(chave).replace(/\D/g, ""),
    );
  });
}

/** @deprecated use marcarFalhaRede */
function marcarFalha(chave, erro) {
  marcarFalhaRede(chave, erro);
}

function contarPendentes() {
  if (!db) return 0;
  try {
    ensureSchema();
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM nfce_offline_pendentes WHERE status='PENDENTE'`)
      .get();
    return row ? row.n : 0;
  } catch (_) {
    return 0;
  }
}

function contarRejeicoes() {
  if (!db) return 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM nfce_offline_pendentes WHERE status='FALHA_PERMANENTE'`)
      .get();
    return row ? row.n : 0;
  } catch (_) {
    return 0;
  }
}

function metricasIdade() {
  if (!db) {
    return { pendentes: 0, rejeicoes: 0, maisAntigaIso: null, maisAntigaHoras: 0, estouradas: [] };
  }
  ensureSchema();
  const horasLimite = require("./contingenciaOffline").alertaIdadeHoras();
  const pendentes = contarPendentes();
  const rejeicoes = contarRejeicoes();
  const oldest = db
    .prepare(
      `SELECT criado_em FROM nfce_offline_pendentes WHERE status='PENDENTE' ORDER BY id LIMIT 1`,
    )
    .get();
  let maisAntigaHoras = 0;
  if (oldest?.criado_em) {
    const t = Date.parse(oldest.criado_em);
    if (Number.isFinite(t)) maisAntigaHoras = (Date.now() - t) / 3_600_000;
  }
  const estouradas = db
    .prepare(
      `SELECT chave, numero_venda, criado_em, tentativas
       FROM nfce_offline_pendentes
       WHERE status='PENDENTE'`,
    )
    .all()
    .filter((r) => {
      const t = Date.parse(r.criado_em);
      return Number.isFinite(t) && (Date.now() - t) / 3_600_000 >= horasLimite;
    });
  return {
    pendentes,
    rejeicoes,
    maisAntigaIso: oldest?.criado_em || null,
    maisAntigaHoras,
    alertaIdadeHoras: horasLimite,
    alertaIdade: estouradas.length > 0,
    estouradas,
  };
}

function obterOuAbrirJanelaDhCont(agora = new Date()) {
  ensureSchema();
  const formatado = fiscalDhEmiIni.formatarDhEmiAcbrIni(agora);
  return withImmediate(() => {
    const row = db.prepare(`SELECT dh_cont, fechada_em FROM nfce_offline_janela WHERE id=1`).get();
    if (row && !row.fechada_em) return row.dh_cont;
    const iso = agora.toISOString();
    db.prepare(
      `INSERT INTO nfce_offline_janela (id, dh_cont, aberta_em, fechada_em)
       VALUES (1, @dh, @iso, NULL)
       ON CONFLICT(id) DO UPDATE SET dh_cont=@dh, aberta_em=@iso, fechada_em=NULL`,
    ).run({ dh: formatado, iso });
    return formatado;
  });
}

function fecharJanelaDhCont() {
  if (!db) return false;
  ensureSchema();
  const info = withImmediate(() =>
    db
      .prepare(
        `UPDATE nfce_offline_janela SET fechada_em = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=1 AND fechada_em IS NULL`,
      )
      .run(),
  );
  return info.changes > 0;
}

function janelaAberta() {
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT * FROM nfce_offline_janela WHERE id=1`).get();
    if (!row || row.fechada_em) return null;
    return row;
  } catch (_) {
    return null;
  }
}

module.exports = {
  bind,
  ensureSchema,
  enqueue,
  listPendentes,
  claimPendentes,
  marcarTransmitido,
  marcarFalhaRede,
  marcarRejeicao,
  marcarFalha,
  contarPendentes,
  contarRejeicoes,
  metricasIdade,
  obterOuAbrirJanelaDhCont,
  fecharJanelaDhCont,
  janelaAberta,
};
