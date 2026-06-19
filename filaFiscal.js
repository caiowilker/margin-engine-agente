// Fila fiscal persistente — emissão, callback, cancelamento, inutilização, EPEC
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const fiscalRetry = require("./fiscalRetry");
const log = require("./logger");

const TIPOS = [
  "EMISSAO",
  "CALLBACK_BACKEND",
  "CANCELAMENTO",
  "INUTILIZACAO",
  "EPEC",
];
const STATUS = {
  PENDENTE: "PENDENTE",
  PROCESSANDO: "PROCESSANDO",
  CONCLUIDO: "CONCLUIDO",
  FALHA_PERMANENTE: "FALHA_PERMANENTE",
  INCERTO: "INCERTO",
};

const MAX_TENTATIVAS = 10;
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];

let db = null;
let workerTimer = null;
let processando = false;
let filaPausada = false;
let handlers = {};

function dbPath() {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "fila_fiscal.db");
}

function init() {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS fila_fiscal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      correlation_id TEXT,
      payload TEXT NOT NULL,
      tentativas INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PENDENTE',
      erro TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      proxima_tentativa TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_status ON fila_fiscal(status, proxima_tentativa);
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_corr ON fila_fiscal(correlation_id);
    CREATE TABLE IF NOT EXISTS documentos_fiscais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT UNIQUE,
      numero_venda TEXT,
      correlation_id TEXT,
      c_stat TEXT,
      protocolo TEXT,
      xml_path TEXT,
      pdf_path TEXT,
      tipo TEXT DEFAULT 'AUTORIZADA',
      criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS emissao_resultados (
      correlation_id TEXT PRIMARY KEY,
      numero_venda TEXT,
      status TEXT NOT NULL,
      resultado TEXT,
      erro TEXT,
      atualizado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_emissao_resultados_venda ON emissao_resultados(numero_venda);
  `);
  // Recovery: PROCESSANDO → PENDENTE
  db.prepare(
    `UPDATE fila_fiscal SET status = 'PENDENTE' WHERE status = 'PROCESSANDO'`,
  ).run();
  return db;
}

function enfileirar(tipo, payload, correlationId = null) {
  init();
  const payloadStr = JSON.stringify(payload);
  if (correlationId && tipo === "EMISSAO") {
    const dup = db
      .prepare(
        `SELECT id FROM fila_fiscal WHERE tipo = 'EMISSAO' AND correlation_id = ?
         AND status IN ('PENDENTE','PROCESSANDO','INCERTO') LIMIT 1`,
      )
      .get(correlationId);
    if (dup) return dup.id;
  }
  const existente = db
    .prepare(
      `SELECT id FROM fila_fiscal WHERE tipo = ? AND payload = ? AND status IN ('PENDENTE','PROCESSANDO','INCERTO') LIMIT 1`,
    )
    .get(tipo, payloadStr);
  if (existente) return existente.id;
  const r = db
    .prepare(
      `INSERT INTO fila_fiscal (tipo, correlation_id, payload, status) VALUES (?, ?, ?, 'PENDENTE')`,
    )
    .run(tipo, correlationId, payloadStr);
  return r.lastInsertRowid;
}

function proximoJob() {
  init();
  return db
    .prepare(
      `SELECT * FROM fila_fiscal
       WHERE status IN ('PENDENTE','INCERTO')
         AND datetime(proxima_tentativa) <= datetime('now')
       ORDER BY id ASC LIMIT 1`,
    )
    .get();
}

function marcar(id, status, erro = null) {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET status = ?, erro = ?, tentativas = tentativas + 1 WHERE id = ?`,
  ).run(status, erro, id);
}

function agendarRetry(id, tentativas, err) {
  const cStat = fiscalRetry.extrairCStat(err);
  const base =
    cStat === "999"
      ? [30000, 60000, 120000]
      : BACKOFF_MS;
  const ms = base[Math.min(tentativas - 1, base.length - 1)];
  const proxima = new Date(Date.now() + ms).toISOString();
  db.prepare(
    `UPDATE fila_fiscal SET status = 'PENDENTE', proxima_tentativa = ? WHERE id = ?`,
  ).run(proxima, id);
}

function marcarIncerto(id, erro) {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET status = 'INCERTO', erro = ? WHERE id = ?`,
  ).run(erro, id);
}

async function processarUm() {
  if (processando || filaPausada) return false;
  const job = proximoJob();
  if (!job) return false;
  processando = true;
  db.prepare(`UPDATE fila_fiscal SET status = 'PROCESSANDO' WHERE id = ?`).run(
    job.id,
  );
  const handler = handlers[job.tipo];
  if (!handler) {
    marcar(job.id, STATUS.FALHA_PERMANENTE, "Handler ausente: " + job.tipo);
    processando = false;
    return true;
  }
  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch (e) {
    marcar(job.id, STATUS.FALHA_PERMANENTE, "Payload JSON inválido");
    processando = false;
    return true;
  }
  try {
    await handler(payload, job);
    db.prepare(`UPDATE fila_fiscal SET status = 'CONCLUIDO' WHERE id = ?`).run(
      job.id,
    );
  } catch (err) {
    fiscalRetry.enriquecerErro(err);
    const msg = err.message || String(err);
    const tentativas = job.tentativas + 1;
    log.warn(
      { modulo: "fila_fiscal", tipo: job.tipo, tentativas, err: msg },
      "Falha ao processar job fiscal",
    );
    if (fiscalRetry.isIncerto(err)) {
      marcarIncerto(job.id, msg);
    } else if (
      fiscalRetry.isPermanente(err) ||
      tentativas >= fiscalRetry.maxTentativas(err)
    ) {
      const msgFinal =
        fiscalRetry.extrairCStat(err) === "999" &&
        tentativas >= fiscalRetry.maxTentativas(err)
          ? fiscalRetry.mensagem999Exaurido(tentativas)
          : msg;
      marcar(job.id, STATUS.FALHA_PERMANENTE, msgFinal);
      if (job.tipo === "EMISSAO" && payload?.correlationId) {
        salvarResultadoEmissao(
          payload.correlationId,
          payload.numeroVenda,
          "FALHA_PERMANENTE",
          null,
          msgFinal,
        );
      }
    } else {
      db.prepare(
        `UPDATE fila_fiscal SET status = 'PENDENTE', erro = ?, tentativas = ? WHERE id = ?`,
      ).run(msg, tentativas, job.id);
      agendarRetry(job.id, tentativas, err);
    }
  }
  processando = false;
  return true;
}

function registrarHandler(tipo, fn) {
  handlers[tipo] = fn;
}

function iniciarWorker(intervalMs = 5000) {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    let again = true;
    while (again && !filaPausada) {
      again = await processarUm();
    }
  }, intervalMs);
}

function pausarFila() {
  filaPausada = true;
}

function retomarFila() {
  filaPausada = false;
}

function status() {
  init();
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) as qtd FROM fila_fiscal GROUP BY status`,
    )
    .all();
  const map = {};
  rows.forEach((r) => {
    map[r.status] = r.qtd;
  });
  return {
    pausada: filaPausada,
    pendentes: map.PENDENTE || 0,
    incerto: map.INCERTO || 0,
    falhas: map.FALHA_PERMANENTE || 0,
    concluidos: map.CONCLUIDO || 0,
    processando: map.PROCESSANDO || 0,
  };
}

function listar(limit = 50) {
  init();
  return db
    .prepare(
      `SELECT id, tipo, correlation_id, status, tentativas, erro, criado_em
       FROM fila_fiscal ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

function salvarDocumento(doc) {
  init();
  db.prepare(
    `INSERT OR REPLACE INTO documentos_fiscais
     (chave, numero_venda, correlation_id, c_stat, protocolo, xml_path, pdf_path, tipo)
     VALUES (@chave, @numeroVenda, @correlationId, @cStat, @protocolo, @xmlPath, @pdfPath, @tipo)`,
  ).run({
    chave: doc.chave,
    numeroVenda: doc.numeroVenda || null,
    correlationId: doc.correlationId || null,
    cStat: doc.cStat || null,
    protocolo: doc.protocolo || null,
    xmlPath: doc.xmlPath || null,
    pdfPath: doc.pdfPath || null,
    tipo: doc.tipo || "AUTORIZADA",
  });
}

function buscarDocumentoPorChave(chave) {
  init();
  return db
    .prepare(`SELECT * FROM documentos_fiscais WHERE chave = ?`)
    .get(chave);
}

function buscarDocumentoPorVenda(numeroVenda) {
  init();
  return db
    .prepare(
      `SELECT * FROM documentos_fiscais WHERE numero_venda = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(numeroVenda);
}

function salvarResultadoEmissao(correlationId, numeroVenda, status, resultado, erro) {
  init();
  db.prepare(
    `INSERT INTO emissao_resultados (correlation_id, numero_venda, status, resultado, erro, atualizado_em)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(correlation_id) DO UPDATE SET
       status = excluded.status,
       resultado = excluded.resultado,
       erro = excluded.erro,
       atualizado_em = datetime('now')`,
  ).run(
    correlationId,
    numeroVenda || null,
    status,
    resultado ? JSON.stringify(resultado) : null,
    erro || null,
  );
}

function obterResultadoEmissao(correlationId) {
  init();
  return db
    .prepare(`SELECT * FROM emissao_resultados WHERE correlation_id = ?`)
    .get(correlationId);
}

function aguardarConclusao(correlationId, timeoutMs = 120000) {
  const inicio = Date.now();
  const pollMs = parseInt(process.env.FISCAL_POLL_MS || "200", 10);
  return new Promise((resolve, reject) => {
    const poll = () => {
      const row = obterResultadoEmissao(correlationId);
      if (row?.status === "CONCLUIDO" && row.resultado) {
        try {
          resolve(JSON.parse(row.resultado));
          return;
        } catch {
          reject(new Error("Resultado de emissão corrompido"));
          return;
        }
      }
      if (row?.status === "FALHA_PERMANENTE") {
        reject(new Error(row.erro || "Emissão fiscal falhou"));
        return;
      }

      init();
      const job = db
        .prepare(
          `SELECT status, erro FROM fila_fiscal
           WHERE correlation_id = ? AND tipo = 'EMISSAO'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(correlationId);
      if (job?.status === "FALHA_PERMANENTE") {
        reject(new Error(job.erro || row?.erro || "Emissão fiscal falhou"));
        return;
      }

      if (Date.now() - inicio >= timeoutMs) {
        reject(
          new Error(
            "Timeout aguardando emissão fiscal na fila — verifique ACBr Monitor (porta 9200) e logs do agente",
          ),
        );
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

function dispararProcessamento() {
  if (filaPausada) return;
  setImmediate(async () => {
    let again = true;
    while (again && !filaPausada) {
      again = await processarUm();
    }
  });
}

function reprocessarIncertos() {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET status = 'PENDENTE', proxima_tentativa = datetime('now')
     WHERE status = 'INCERTO'`,
  ).run();
}

function buscarJobEmissaoPorVenda(numeroVenda) {
  init();
  return db
    .prepare(
      `SELECT * FROM fila_fiscal WHERE tipo = 'EMISSAO' AND payload LIKE ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(`%"numeroVenda":"${numeroVenda}"%`);
}

/** Cancela jobs de emissão pendentes (evita retentativas com payload antigo após reinício). */
function cancelarEmissaoPendente(motivo = "Cancelado — reinício do agente") {
  init();
  const r = db
    .prepare(
      `UPDATE fila_fiscal SET status = 'FALHA_PERMANENTE', erro = ?
       WHERE tipo = 'EMISSAO' AND status IN ('PENDENTE', 'INCERTO', 'PROCESSANDO')`,
    )
    .run(motivo);
  return r.changes;
}

module.exports = {
  TIPOS,
  STATUS,
  init,
  enfileirar,
  registrarHandler,
  iniciarWorker,
  pausarFila,
  retomarFila,
  status,
  listar,
  salvarDocumento,
  buscarDocumentoPorChave,
  buscarDocumentoPorVenda,
  salvarResultadoEmissao,
  obterResultadoEmissao,
  aguardarConclusao,
  reprocessarIncertos,
  buscarJobEmissaoPorVenda,
  cancelarEmissaoPendente,
  marcarIncerto,
  dispararProcessamento,
};
