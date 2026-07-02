// Fila fiscal persistente v2 — prioridade, idempotência, estados completos
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const fiscalRetry = require("./fiscalRetry");
const log = require("./logger");
const { getDirectoryManager } = require("./runtime/directoryManager");

const TIPOS = [
  "EMISSAO",
  "GERAR_PDF",
  "CALLBACK_BACKEND",
  "CANCELAMENTO",
  "INUTILIZACAO",
  "EPEC",
  "EVENTO_FISCAL",
];

const STATUS = {
  PENDENTE: "PENDENTE",
  PROCESSANDO: "PROCESSANDO",
  INCERTO: "INCERTO",
  RECUPERANDO: "RECUPERANDO",
  CONCLUIDO: "CONCLUIDO",
  FALHA_TEMPORARIA: "FALHA_TEMPORARIA",
  FALHA_PERMANENTE: "FALHA_PERMANENTE",
};

const STATUS_ATIVOS = [
  "PENDENTE",
  "PROCESSANDO",
  "INCERTO",
  "FALHA_TEMPORARIA",
];

const PRIORIDADE = {
  EMISSAO: 1,
  CANCELAMENTO: 2,
  CALLBACK_BACKEND: 3,
  GERAR_PDF: 4,
  INUTILIZACAO: 5,
  EPEC: 6,
  EVENTO_FISCAL: 7,
};

const BACKOFF_MS = [60000, 120000, 300000, 900000, 1800000];
const WORKER_MS = parseInt(process.env.FISCAL_WORKER_MS || "500", 10);
const PDF_WORKER_MS = parseInt(process.env.FISCAL_PDF_WORKER_MS || "2000", 10);

let db = null;
let workerTimer = null;
let pdfWorkerTimer = null;
let processandoFiscal = false;
let processandoPdf = false;
let filaPausada = false;
let handlers = {};

function dbPath() {
  if (process.env.FISCAL_DB_PATH) return process.env.FISCAL_DB_PATH;
  const p = getDirectoryManager().file("agent", "fila_fiscal.db");
  getDirectoryManager().ensurePath(path.dirname(p), "agentData");
  return p;
}

function migrateSchema() {
  const cols = db.prepare(`PRAGMA table_info(fila_fiscal)`).all();
  const names = cols.map((c) => c.name);
  if (!names.includes("numero_venda")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN numero_venda TEXT`);
  }
  if (!names.includes("prioridade")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN prioridade INTEGER DEFAULT 5`);
  }
  if (!names.includes("chave_fiscal")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN chave_fiscal TEXT`);
  }
  if (!names.includes("tentativas_consulta")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN tentativas_consulta INTEGER DEFAULT 0`);
  }
  if (!names.includes("proximo_retry_at")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN proximo_retry_at TEXT`);
    db.exec(
      `UPDATE fila_fiscal SET proximo_retry_at = COALESCE(proxima_tentativa, datetime('now'))
       WHERE proximo_retry_at IS NULL`,
    );
  }
  if (!names.includes("processando_desde")) {
    db.exec(`ALTER TABLE fila_fiscal ADD COLUMN processando_desde TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_numero_venda ON fila_fiscal(numero_venda);
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_status ON fila_fiscal(status, proxima_tentativa);
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_corr ON fila_fiscal(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_criado ON fila_fiscal(criado_em);
    CREATE INDEX IF NOT EXISTS idx_fila_fiscal_retry ON fila_fiscal(status, proximo_retry_at);
    CREATE INDEX IF NOT EXISTS idx_emissao_resultados_venda ON emissao_resultados(numero_venda);
  `);
  const docCols = db.prepare(`PRAGMA table_info(documentos_fiscais)`).all();
  const docNames = docCols.map((c) => c.name);
  if (!docNames.includes("serie_nfe")) {
    db.exec(`ALTER TABLE documentos_fiscais ADD COLUMN serie_nfe TEXT`);
  }
  if (!docNames.includes("numero_nfe")) {
    db.exec(`ALTER TABLE documentos_fiscais ADD COLUMN numero_nfe TEXT`);
  }
  if (!docNames.includes("modelo_documento")) {
    db.exec(`ALTER TABLE documentos_fiscais ADD COLUMN modelo_documento TEXT`);
  }
  db.prepare(
    `UPDATE fila_fiscal SET prioridade = CASE tipo
      WHEN 'EMISSAO' THEN 1 WHEN 'CANCELAMENTO' THEN 2
      WHEN 'CALLBACK_BACKEND' THEN 3 WHEN 'GERAR_PDF' THEN 4 ELSE 5 END
     WHERE prioridade IS NULL OR prioridade = 5`,
  ).run();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fila_fiscal_chave ON fila_fiscal(chave_fiscal)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  sanitizarPayloadsLegados();
  backfillNumeroVendaColuna();
}

function sanitizarPayloadsLegados() {
  const done = db
    .prepare(`SELECT value FROM agent_meta WHERE key = 'payloads_legados_v1'`)
    .get();
  if (done?.value === "1") return;

  const rows = db.prepare(`SELECT id, payload FROM fila_fiscal`).all();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload);
      if (!p.cfg && !p.backendToken) continue;
      delete p.cfg;
      delete p.backendToken;
      db.prepare(`UPDATE fila_fiscal SET payload = ? WHERE id = ?`).run(
        JSON.stringify(p),
        row.id,
      );
    } catch (_) {}
  }
  db.prepare(
    `INSERT OR REPLACE INTO agent_meta (key, value) VALUES ('payloads_legados_v1', '1')`,
  ).run();
}

function backfillNumeroVendaColuna() {
  const rows = db
    .prepare(`SELECT id, payload, numero_venda, chave_fiscal FROM fila_fiscal WHERE numero_venda IS NULL OR (chave_fiscal IS NULL AND tipo = 'GERAR_PDF')`)
    .all();
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload);
      const nv = p.numeroVenda || p.numero_venda;
      if (nv && !row.numero_venda) {
        db.prepare(`UPDATE fila_fiscal SET numero_venda = ? WHERE id = ?`).run(nv, row.id);
      }
      if (p.chave && !row.chave_fiscal) {
        db.prepare(`UPDATE fila_fiscal SET chave_fiscal = ? WHERE id = ?`).run(p.chave, row.id);
      }
    } catch (_) {}
  }
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
      numero_venda TEXT,
      chave_fiscal TEXT,
      prioridade INTEGER DEFAULT 5,
      payload TEXT NOT NULL,
      tentativas INTEGER DEFAULT 0,
      tentativas_consulta INTEGER DEFAULT 0,
      status TEXT DEFAULT 'PENDENTE',
      erro TEXT,
      criado_em TEXT DEFAULT (datetime('now')),
      proxima_tentativa TEXT DEFAULT (datetime('now')),
      proximo_retry_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS documentos_fiscais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT UNIQUE,
      numero_venda TEXT,
      correlation_id TEXT,
      serie_nfe TEXT,
      numero_nfe TEXT,
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
  `);
  migrateSchema();
  return db;
}

function prioridadeTipo(tipo) {
  return PRIORIDADE[tipo] || 5;
}

function extrairNumeroVenda(payload, correlationId) {
  return payload?.numeroVenda || payload?.numero_venda || null;
}

function vendaTemJobAtivo(numeroVenda) {
  if (!numeroVenda) return null;
  init();
  return db
    .prepare(
      `SELECT id, correlation_id, status FROM fila_fiscal
       WHERE tipo = 'EMISSAO' AND numero_venda = ?
         AND status IN ('PENDENTE','PROCESSANDO','INCERTO','FALHA_TEMPORARIA','RECUPERANDO')
       LIMIT 1`,
    )
    .get(String(numeroVenda));
}

function vendaJaConcluida(numeroVenda) {
  init();
  const r = db
    .prepare(
      `SELECT correlation_id, status, resultado FROM emissao_resultados
       WHERE numero_venda = ? AND status IN ('CONCLUIDO','CONCLUIDO_RECUPERADO')
       ORDER BY datetime(atualizado_em) DESC LIMIT 1`,
    )
    .get(numeroVenda);
  return r || null;
}

function enfileirar(tipo, payload, correlationId = null, numeroVenda = null) {
  init();
  const nv = numeroVenda || extrairNumeroVenda(payload, correlationId);
  const payloadClean = { ...payload };
  delete payloadClean.cfg;
  delete payloadClean.backendToken;
  const payloadStr = JSON.stringify(payloadClean);

  if (tipo === "EMISSAO" && nv) {
    const concluida = vendaJaConcluida(nv);
    if (concluida?.resultado) {
      return { id: null, deduplicado: true, concluido: true, correlationId: concluida.correlation_id };
    }
    const ativo = vendaTemJobAtivo(nv);
    if (ativo) {
      return {
        id: ativo.id,
        deduplicado: true,
        correlationId: ativo.correlation_id,
        status: ativo.status,
      };
    }
  }

  if (correlationId && tipo === "EMISSAO") {
    const dup = db
      .prepare(
        `SELECT id, correlation_id FROM fila_fiscal WHERE tipo = 'EMISSAO' AND correlation_id = ?
         AND status IN ('PENDENTE','PROCESSANDO','INCERTO','FALHA_TEMPORARIA') LIMIT 1`,
      )
      .get(correlationId);
    if (dup) return { id: dup.id, deduplicado: true, correlationId: dup.correlation_id };
  }

  if (correlationId && tipo === "EPEC") {
    const dup = db
      .prepare(
        `SELECT id, correlation_id FROM fila_fiscal WHERE tipo = 'EPEC' AND correlation_id = ?
         AND status IN ('PENDENTE','PROCESSANDO','INCERTO','FALHA_TEMPORARIA','RECUPERANDO') LIMIT 1`,
      )
      .get(correlationId);
    if (dup) return { id: dup.id, deduplicado: true, correlationId: dup.correlation_id };
  }

  if (tipo === "GERAR_PDF" && payloadClean.chave) {
    const dupPdf = db
      .prepare(
        `SELECT id FROM fila_fiscal WHERE tipo = 'GERAR_PDF' AND chave_fiscal = ?
         AND status IN ('PENDENTE','PROCESSANDO','INCERTO','FALHA_TEMPORARIA','RECUPERANDO') LIMIT 1`,
      )
      .get(String(payloadClean.chave));
    if (dupPdf) return { id: dupPdf.id, deduplicado: true };
  }

  const existente = db
    .prepare(
      `SELECT id FROM fila_fiscal WHERE tipo = ? AND payload = ?
       AND status IN ('PENDENTE','PROCESSANDO','INCERTO','FALHA_TEMPORARIA') LIMIT 1`,
    )
    .get(tipo, payloadStr);
  if (existente) return { id: existente.id, deduplicado: true };

  const chaveFiscal =
    tipo === "GERAR_PDF" && payloadClean.chave ? String(payloadClean.chave) : null;
  const r = db
    .prepare(
      `INSERT INTO fila_fiscal (tipo, correlation_id, numero_venda, chave_fiscal, prioridade, payload, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDENTE')`,
    )
    .run(tipo, correlationId, nv, chaveFiscal, prioridadeTipo(tipo), payloadStr);
  return { id: r.lastInsertRowid, deduplicado: false, correlationId };
}

function atualizarPayload(jobId, patch) {
  init();
  const job = db.prepare(`SELECT payload FROM fila_fiscal WHERE id = ?`).get(jobId);
  if (!job) return;
  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return;
  }
  Object.assign(payload, patch);
  delete payload.cfg;
  delete payload.backendToken;
  db.prepare(`UPDATE fila_fiscal SET payload = ? WHERE id = ?`).run(
    JSON.stringify(payload),
    jobId,
  );
}

function proximoJob(tiposPermitidos = null) {
  init();
  let sql = `
    SELECT * FROM fila_fiscal
    WHERE status IN ('PENDENTE','FALHA_TEMPORARIA')
      AND datetime(proxima_tentativa) <= datetime('now')`;
  if (tiposPermitidos?.length) {
    sql += ` AND tipo IN (${tiposPermitidos.map(() => "?").join(",")})`;
  }
  sql += ` ORDER BY prioridade ASC, id ASC LIMIT 1`;
  return tiposPermitidos?.length
    ? db.prepare(sql).get(...tiposPermitidos)
    : db.prepare(sql).get();
}

function marcarJob(id, status, erro = null) {
  init();
  db.prepare(`UPDATE fila_fiscal SET status = ?, erro = ? WHERE id = ?`).run(
    status,
    erro,
    id,
  );
}

function marcar(id, status, erro = null) {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET status = ?, erro = ?, tentativas = tentativas + 1 WHERE id = ?`,
  ).run(status, erro, id);
}

function agendarRetry(id, tentativas, err) {
  const cStat = fiscalRetry.extrairCStat(err);
  const base = cStat === "999" ? [30000, 60000, 120000] : BACKOFF_MS;
  const ms = base[Math.min(tentativas - 1, base.length - 1)];
  const proxima = new Date(Date.now() + ms).toISOString();
  db.prepare(
    `UPDATE fila_fiscal SET status = 'FALHA_TEMPORARIA', proxima_tentativa = ? WHERE id = ?`,
  ).run(proxima, id);
}

function marcarIncerto(id, erro, correlationId, numeroVenda, meta = {}) {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET status = 'INCERTO', erro = ?, proximo_retry_at = datetime('now') WHERE id = ?`,
  ).run(erro, id);
  if (meta.chaveConsulta) {
    let payloadAtual = {};
    try {
      const row = db.prepare(`SELECT payload FROM fila_fiscal WHERE id = ?`).get(id);
      payloadAtual = JSON.parse(row?.payload || "{}");
    } catch (_) {}
    atualizarPayload(id, {
      chaveConsulta: meta.chaveConsulta,
      motivoIncerto: "104",
      _fiscalMeta: {
        ...(payloadAtual._fiscalMeta || {}),
        chave: meta.chaveConsulta,
        cStat: meta.cStat || "104",
      },
    });
  }
  if (correlationId) {
    salvarResultadoEmissao(correlationId, numeroVenda, "INCERTO", null, erro);
  }
}

async function processarUm(opcoes = {}) {
  const { apenasTipos = null, flag = "processandoFiscal" } = opcoes;
  if (filaPausada || (flag === "processandoFiscal" ? processandoFiscal : processandoPdf))
    return false;

  const job = proximoJob(apenasTipos);
  if (!job) return false;

  if (flag === "processandoFiscal") processandoFiscal = true;
  else processandoPdf = true;

  db.prepare(`UPDATE fila_fiscal SET status = 'PROCESSANDO', processando_desde = datetime('now') WHERE id = ?`).run(job.id);
  const handler = handlers[job.tipo];
  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch (e) {
    marcar(job.id, STATUS.FALHA_PERMANENTE, "Dados do pedido fiscal inválidos");
    if (flag === "processandoFiscal") processandoFiscal = false;
    else processandoPdf = false;
    return true;
  }

  if (!handler) {
    marcar(job.id, STATUS.FALHA_PERMANENTE, "Handler ausente: " + job.tipo);
    if (flag === "processandoFiscal") processandoFiscal = false;
    else processandoPdf = false;
    return true;
  }

  try {
    await handler(payload, job);
    db.prepare(`UPDATE fila_fiscal SET status = 'CONCLUIDO' WHERE id = ?`).run(job.id);
  } catch (err) {
    fiscalRetry.enriquecerErro(err);
    const msg = err.message || String(err);
    const tentativas = job.tentativas + 1;
    if (fiscalRetry.isIncerto(err)) {
      log.info(
        { modulo: "fila_fiscal", tipo: job.tipo, jobId: job.id, err: msg },
        "Emissão incerta — recovery consultará SEFAZ (sem reemissão)",
      );
      marcarIncerto(
        job.id,
        msg,
        payload.correlationId || job.correlation_id,
        payload.numeroVenda || job.numero_venda,
        {
          chaveConsulta: err.chaveConsulta || payload._fiscalMeta?.chave,
          cStat: fiscalRetry.extrairCStat(err),
        },
      );
    } else if (
      fiscalRetry.isPermanente(err) ||
      tentativas >= fiscalRetry.maxTentativas(err)
    ) {
      log.error(
        {
          acao: job.tipo,
          resultado: "FALHA_PERMANENTE",
          correlationId: payload.correlationId || job.correlation_id,
          numeroVenda: payload.numeroVenda || job.numero_venda,
          err: msg,
        },
        "Falha permanente ao processar job fiscal",
      );
      const msgFinal =
        fiscalRetry.extrairCStat(err) === "999" &&
        tentativas >= fiscalRetry.maxTentativas(err)
          ? fiscalRetry.mensagem999Exaurido(tentativas)
          : msg;
      marcar(job.id, STATUS.FALHA_PERMANENTE, msgFinal);
      if (job.tipo === "EMISSAO") {
        salvarResultadoEmissao(
          payload.correlationId || job.correlation_id,
          payload.numeroVenda || job.numero_venda,
          "FALHA_PERMANENTE",
          null,
          msgFinal,
        );
        try {
          const fiscalAlertas = require("./fiscalAlertas");
          fiscalAlertas.alertarFalhaPermanente({
            correlationId: payload.correlationId || job.correlation_id,
            numeroVenda: payload.numeroVenda || job.numero_venda,
            motivo: msgFinal,
            jobId: job.id,
          });
        } catch (_) {}
        setImmediate(() => {
          require("./fiscalService")
            .notificarPendenciaFiscalFailSafe(
              payload.numeroVenda || job.numero_venda,
              payload.correlationId || job.correlation_id,
              err,
            )
            .catch(() => {});
        });
      }
    } else {
      log.warn(
        { modulo: "fila_fiscal", tipo: job.tipo, tentativas, err: msg },
        "Falha ao processar job fiscal",
      );
      db.prepare(
        `UPDATE fila_fiscal SET erro = ?, tentativas = ? WHERE id = ?`,
      ).run(msg, tentativas, job.id);
      agendarRetry(job.id, tentativas, err);
      if (job.tipo === "EMISSAO") {
        salvarResultadoEmissao(
          payload.correlationId || job.correlation_id,
          payload.numeroVenda || job.numero_venda,
          "FALHA_TEMPORARIA",
          null,
          msg,
        );
      }
    }
  }

  if (flag === "processandoFiscal") processandoFiscal = false;
  else processandoPdf = false;
  return true;
}

function registrarHandler(tipo, fn) {
  handlers[tipo] = fn;
}

function liberarJobsTravados(minutos = null) {
  init();
  const min = minutos ?? parseInt(process.env.FISCAL_JOB_STALE_MIN || "15", 10);
  const jobs = db
    .prepare(
      `SELECT id, correlation_id, numero_venda, tipo FROM fila_fiscal
       WHERE status = 'PROCESSANDO'
         AND (
           (processando_desde IS NOT NULL AND datetime(processando_desde) < datetime('now', ?))
           OR (processando_desde IS NULL AND tipo = 'EMISSAO' AND datetime(criado_em) < datetime('now', ?))
           OR (processando_desde IS NULL AND tipo != 'EMISSAO' AND datetime(criado_em) < datetime('now', '-5 minutes'))
         )`,
    )
    .all(`-${min} minutes`, `-${min} minutes`);
  if (!jobs.length) return 0;
  for (const job of jobs) {
    const msg = `Job travado em PROCESSANDO há mais de ${min} min — aguardando recovery`;
    db.prepare(`UPDATE fila_fiscal SET status = 'INCERTO', erro = ?, proximo_retry_at = datetime('now') WHERE id = ?`).run(
      msg,
      job.id,
    );
    if (job.correlation_id) {
      salvarResultadoEmissao(job.correlation_id, job.numero_venda, "INCERTO", null, msg);
    }
  }
  return jobs.length;
}

function iniciarWorker(intervalMs = WORKER_MS) {
  if (workerTimer) return;
  const tiposFiscal = ["EMISSAO", "CANCELAMENTO", "CALLBACK_BACKEND", "INUTILIZACAO", "EPEC", "EVENTO_FISCAL"];
  workerTimer = setInterval(async () => {
    try {
      liberarJobsTravados();
    } catch (_) {}
    let again = true;
    while (again && !filaPausada) {
      again = await processarUm({ apenasTipos: tiposFiscal, flag: "processandoFiscal" });
    }
  }, intervalMs);

  // Worker GERAR_PDF sempre ativo — handler ignora NFC-e 65 quando FISCAL_GERAR_PDF=false, mas processa NF-e 55.
  if (!pdfWorkerTimer) {
    pdfWorkerTimer = setInterval(async () => {
      if (acbrOcupado()) return;
      let again = true;
      while (again && !filaPausada && !acbrOcupado()) {
        again = await processarUm({ apenasTipos: ["GERAR_PDF"], flag: "processandoPdf" });
      }
    }, PDF_WORKER_MS);
  }
}

function pararWorkers() {
  if (workerTimer) clearInterval(workerTimer);
  if (pdfWorkerTimer) clearInterval(pdfWorkerTimer);
  workerTimer = null;
  pdfWorkerTimer = null;
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
    .prepare(`SELECT status, COUNT(*) as qtd FROM fila_fiscal GROUP BY status`)
    .all();
  const map = {};
  rows.forEach((r) => {
    map[r.status] = r.qtd;
  });
  return {
    pausada: filaPausada,
    pendentes: map.PENDENTE || 0,
    incerto: map.INCERTO || 0,
    recuperando: map.RECUPERANDO || 0,
    falhasTemporarias: map.FALHA_TEMPORARIA || 0,
    falhas: map.FALHA_PERMANENTE || 0,
    concluidos: map.CONCLUIDO || 0,
    processando: map.PROCESSANDO || 0,
  };
}

function listarJobsAtivos() {
  init();
  return db
    .prepare(
      `SELECT id, tipo, correlation_id, numero_venda, status
       FROM fila_fiscal WHERE status IN ('PROCESSANDO','RECUPERANDO')`,
    )
    .all();
}

async function aguardarJobsAtivos(timeoutMs = 30000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const ativos = listarJobsAtivos();
    const workerBusy = processandoFiscal || processandoPdf;
    if (ativos.length === 0 && !workerBusy) {
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ok: false,
    pendentes: listarJobsAtivos(),
    workerBusy: { processandoFiscal, processandoPdf },
  };
}

function contadoresAlertas() {
  init();
  const st = status();
  const falhasUltimas24h =
    db
      .prepare(
        `SELECT COUNT(*) as n FROM emissao_resultados
         WHERE status IN ('FALHA_PERMANENTE','FALHA_TEMPORARIA','INCERTO')
         AND datetime(atualizado_em) >= datetime('now', '-24 hours')`,
      )
      .get().n || 0;
  const ultimaEmissao = db
    .prepare(
      `SELECT correlation_id, numero_venda, status, atualizado_em
       FROM emissao_resultados ORDER BY datetime(atualizado_em) DESC LIMIT 1`,
    )
    .get();
  const ultimaEmissaoSucesso = db
    .prepare(
      `SELECT correlation_id, numero_venda, status, atualizado_em, resultado
       FROM emissao_resultados
       WHERE status IN ('CONCLUIDO','CONCLUIDO_RECUPERADO')
       ORDER BY datetime(atualizado_em) DESC LIMIT 1`,
    )
    .get();
  const ultimaRejeicao = db
    .prepare(
      `SELECT correlation_id, numero_venda, status, atualizado_em, erro, resultado
       FROM emissao_resultados
       WHERE status IN ('FALHA_PERMANENTE','FALHA_TEMPORARIA','REJEITADA','INCERTO')
         AND (erro IS NOT NULL OR status != 'INCERTO')
       ORDER BY datetime(atualizado_em) DESC LIMIT 1`,
    )
    .get();
  const filaFiscalTotal =
    st.pendentes +
    st.processando +
    st.incerto +
    st.recuperando +
    st.falhasTemporarias;
  const incertosComBackoff =
    db
      .prepare(
        `SELECT COUNT(*) as n FROM fila_fiscal
         WHERE tipo = 'EMISSAO' AND status IN ('INCERTO','RECUPERANDO')
           AND proximo_retry_at IS NOT NULL
           AND datetime(proximo_retry_at) > datetime('now')`,
      )
      .get().n || 0;
  return {
    filaFiscal: filaFiscalTotal,
    processando: st.processando,
    incertos: st.incerto,
    recuperando: st.recuperando,
    incertosComBackoff,
    falhasUltimas24h,
    ultimaEmissao: ultimaEmissao || null,
    ultimaEmissaoSucesso: ultimaEmissaoSucesso || null,
    ultimaRejeicao: ultimaRejeicao || null,
  };
}

function ultimoDocumentoXml() {
  init();
  return (
    db
      .prepare(
        `SELECT chave, xml_path, pdf_path, criado_em, numero_venda
         FROM documentos_fiscais
         WHERE xml_path IS NOT NULL AND xml_path != ''
         ORDER BY id DESC LIMIT 1`,
      )
      .get() || null
  );
}

function listar(limit = 50, statusFilter = null) {
  init();
  const lim = Math.min(Math.max(1, limit), 200);
  if (statusFilter) {
    return db
      .prepare(
        `SELECT id, tipo, correlation_id, numero_venda, status, tentativas, erro, criado_em, proxima_tentativa
         FROM fila_fiscal WHERE status = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(String(statusFilter), lim);
  }
  return db
    .prepare(
      `SELECT id, tipo, correlation_id, numero_venda, status, tentativas, erro, criado_em, proxima_tentativa
       FROM fila_fiscal ORDER BY id DESC LIMIT ?`,
    )
    .all(lim);
}

function salvarDocumento(doc) {
  init();
  db.prepare(
    `INSERT OR REPLACE INTO documentos_fiscais
     (chave, numero_venda, correlation_id, serie_nfe, numero_nfe, c_stat, protocolo, xml_path, pdf_path, tipo, modelo_documento)
     VALUES (@chave, @numeroVenda, @correlationId, @serieNfe, @numeroNfe, @cStat, @protocolo, @xmlPath, @pdfPath, @tipo, @modeloDocumento)`,
  ).run({
    chave: doc.chave,
    numeroVenda: doc.numeroVenda || null,
    correlationId: doc.correlationId || null,
    serieNfe: doc.serieNfe || doc.serie || null,
    numeroNfe: doc.numeroNfe || doc.numero || null,
    cStat: doc.cStat || null,
    protocolo: doc.protocolo || null,
    xmlPath: doc.xmlPath || null,
    pdfPath: doc.pdfPath || null,
    tipo: doc.tipo || "AUTORIZADA",
    modeloDocumento: doc.modeloDocumento || null,
  });
}

function buscarDocumentoPorChave(chave) {
  init();
  return db.prepare(`SELECT * FROM documentos_fiscais WHERE chave = ?`).get(chave);
}

function buscarDocumentoPorVenda(numeroVenda) {
  init();
  return db
    .prepare(
      `SELECT * FROM documentos_fiscais WHERE numero_venda = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(numeroVenda);
}

function buscarDocumentoPorSerieNumero(serie, numero) {
  init();
  return db
    .prepare(
      `SELECT * FROM documentos_fiscais WHERE serie_nfe = ? AND numero_nfe = ? LIMIT 1`,
    )
    .get(String(serie), String(numero));
}

function salvarResultadoEmissao(correlationId, numeroVenda, status, resultado, erro) {
  init();
  db.prepare(
    `INSERT INTO emissao_resultados (correlation_id, numero_venda, status, resultado, erro, atualizado_em)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(correlation_id) DO UPDATE SET
       numero_venda = COALESCE(excluded.numero_venda, emissao_resultados.numero_venda),
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

function obterResultadoPorVenda(numeroVenda) {
  init();
  return db
    .prepare(
      `SELECT * FROM emissao_resultados WHERE numero_venda = ?
       ORDER BY datetime(atualizado_em) DESC LIMIT 1`,
    )
    .get(numeroVenda);
}

function obterJobEmissao(correlationId) {
  init();
  return db
    .prepare(
      `SELECT id, payload, status, correlation_id, numero_venda FROM fila_fiscal
       WHERE correlation_id = ? AND tipo = 'EMISSAO' ORDER BY id DESC LIMIT 1`,
    )
    .get(correlationId);
}

function consultarStatusEmissaoPorVenda(numeroVenda) {
  init();
  const nv = String(numeroVenda || "").trim();
  if (!nv) {
    return { correlationId: null, numeroVenda: nv, status: "NAO_ENCONTRADO", erro: null };
  }
  const row = obterResultadoPorVenda(nv);
  if (row?.correlation_id) {
    return consultarStatusEmissao(row.correlation_id);
  }
  const job = buscarJobEmissaoPorVenda(nv);
  if (job) {
    return {
      correlationId: job.correlation_id,
      numeroVenda: nv,
      status: job.status,
      erro: job.erro || null,
    };
  }
  return { correlationId: null, numeroVenda: nv, status: "NAO_ENCONTRADO", erro: null };
}

function consultarStatusEmissao(correlationId) {
  init();
  const fiscalMotivo = require("./fiscal/fiscalMotivo");
  const row = db
    .prepare(`SELECT * FROM emissao_resultados WHERE correlation_id = ?`)
    .get(correlationId);
  if (!row) {
    const job = db
      .prepare(
        `SELECT status, erro, correlation_id, numero_venda FROM fila_fiscal
         WHERE correlation_id = ? AND tipo = 'EMISSAO' ORDER BY id DESC LIMIT 1`,
      )
      .get(correlationId);
    if (job) {
      return fiscalMotivo.enriquecerStatusEmissao({
        correlationId,
        numeroVenda: job.numero_venda,
        status: job.status,
        erro: job.erro || null,
      });
    }
    return { correlationId, status: "NAO_ENCONTRADO" };
  }
  const jobAtual = db
    .prepare(
      `SELECT status, erro FROM fila_fiscal
       WHERE correlation_id = ? AND tipo = 'EMISSAO' ORDER BY id DESC LIMIT 1`,
    )
    .get(correlationId);
  const statusFinal =
    row.status === "PROCESSANDO" &&
    jobAtual &&
    ["INCERTO", "RECUPERANDO", "FALHA_PERMANENTE", "CONCLUIDO"].includes(jobAtual.status)
      ? jobAtual.status
      : row.status;
  const erroFinal =
    statusFinal !== row.status ? jobAtual?.erro || row.erro : row.erro;
  let resultado = null;
  if (row.resultado) {
    try {
      resultado = JSON.parse(row.resultado);
    } catch {
      resultado = null;
    }
  }
  return fiscalMotivo.enriquecerStatusEmissao({
    correlationId: row.correlation_id,
    numeroVenda: row.numero_venda,
    status: statusFinal,
    resultado,
    erro: erroFinal ? require("./runtime/mensagensOperador").sanitizarErroFila(erroFinal) || erroFinal : null,
    atualizadoEm: row.atualizado_em,
  });
}

function aguardarConclusao(correlationId, timeoutMs = 120000) {
  const inicio = Date.now();
  const pollMs = parseInt(process.env.FISCAL_POLL_MS || "200", 10);
  return new Promise((resolve, reject) => {
    const poll = () => {
      const row = obterResultadoEmissao(correlationId);
      if (
        row &&
        ["CONCLUIDO", "CONCLUIDO_RECUPERADO"].includes(row.status) &&
        row.resultado
      ) {
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
      const job = db
        .prepare(
          `SELECT status, erro FROM fila_fiscal
           WHERE correlation_id = ? AND tipo = 'EMISSAO' ORDER BY id DESC LIMIT 1`,
        )
        .get(correlationId);
      if (job?.status === "FALHA_PERMANENTE") {
        reject(new Error(job.erro || row?.erro || "Emissão fiscal falhou"));
        return;
      }
      if (row?.status === "INCERTO" || job?.status === "INCERTO") {
        const err = new Error(
          row?.erro || job?.erro || "Emissão incerta — recovery consultará SEFAZ",
        );
        err.incerto = true;
        err.correlationId = correlationId;
        reject(err);
        return;
      }
      if (Date.now() - inicio >= timeoutMs) {
        reject(new Error("Timeout aguardando emissão fiscal na fila"));
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
      again = await processarUm({
        apenasTipos: ["EMISSAO", "CANCELAMENTO", "CALLBACK_BACKEND", "INUTILIZACAO", "EPEC", "EVENTO_FISCAL"],
        flag: "processandoFiscal",
      });
    }
  });
  setImmediate(async () => {
    if (acbrOcupado()) return;
    let again = true;
    while (again && !filaPausada && !acbrOcupado()) {
      again = await processarUm({ apenasTipos: ["GERAR_PDF"], flag: "processandoPdf" });
    }
  });
}

function reprocessarIncertos(lerConfigFn) {
  init();
  const jobs = db
    .prepare(`SELECT * FROM fila_fiscal WHERE status = 'INCERTO' AND tipo = 'EMISSAO'`)
    .all();
  if (!jobs.length) {
    return Promise.resolve({ reprocessados: 0 });
  }
  if (typeof lerConfigFn !== "function") {
    log.warn("[fila_fiscal] reprocessarIncertos ignorado — lerConfigFn ausente");
    return Promise.resolve({ reprocessados: 0, aviso: "lerConfigFn ausente" });
  }
  return recuperarBoot(lerConfigFn);
}

function buscarJobEmissaoPorVenda(numeroVenda) {
  init();
  return db
    .prepare(
      `SELECT * FROM fila_fiscal WHERE tipo = 'EMISSAO' AND numero_venda = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(String(numeroVenda));
}

async function recuperarBoot(lerConfigFn) {
  init();
  const fiscalRecuperacao = require("./fiscalRecuperacao");
  const jobs = db
    .prepare(
      `SELECT * FROM fila_fiscal
       WHERE status IN ('PROCESSANDO','INCERTO','RECUPERANDO') ORDER BY id ASC`,
    )
    .all();
  const stats = { recuperados: 0, reagendados: 0, autorizados: 0, agendados: 0 };
  for (const job of jobs) {
    if (job.tipo === "EMISSAO") {
      try {
        db.prepare(
          `UPDATE fila_fiscal SET proximo_retry_at = datetime('now') WHERE id = ?`,
        ).run(job.id);
        marcarJob(job.id, "RECUPERANDO");
        try {
          const payload = JSON.parse(job.payload);
          salvarResultadoEmissao(
            payload.correlationId || job.correlation_id,
            payload.numeroVenda || job.numero_venda,
            "RECUPERANDO",
            null,
            "Consulta de recuperação no boot",
          );
        } catch (_) {}
        const r = await fiscalRecuperacao.tentarRecuperacaoConsulta(
          job,
          lerConfigFn,
        );
        if (r.acao === "RECUPERADO") stats.autorizados++;
        else if (r.acao === "AGENDADO") stats.agendados++;
        else stats.reagendados++;
        stats.recuperados++;
      } catch (err) {
        log.warn(
          { jobId: job.id, err: err.message },
          "Recovery no boot falhou para job — reagendado",
        );
        const tentativas = (job.tentativas_consulta || 0) + 1;
        const proximo = new Date(Date.now() + 45000).toISOString();
        agendarRetryConsulta(job.id, tentativas, proximo);
        stats.reagendados++;
        stats.recuperados++;
      }
    } else {
      db.prepare(
        `UPDATE fila_fiscal SET status = 'PENDENTE', proxima_tentativa = datetime('now') WHERE id = ?`,
      ).run(job.id);
      stats.recuperados++;
    }
  }
  return stats;
}

function listarJobsRecoveryProntos(limit = 10) {
  init();
  return db
    .prepare(
      `SELECT * FROM fila_fiscal
       WHERE tipo = 'EMISSAO' AND status IN ('INCERTO','RECUPERANDO')
         AND (proximo_retry_at IS NULL OR datetime(proximo_retry_at) <= datetime('now'))
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit);
}

function agendarRetryConsulta(jobId, tentativasConsulta, proximoRetryAt) {
  init();
  db.prepare(
    `UPDATE fila_fiscal SET tentativas_consulta = ?, proximo_retry_at = ?, status = 'INCERTO'
     WHERE id = ?`,
  ).run(tentativasConsulta, proximoRetryAt, jobId);
}

function marcarFalhaConsultaTimeout(job, motivo = "ACBr_OFFLINE_TIMEOUT") {
  init();
  let payload = {};
  try {
    payload = JSON.parse(job.payload);
  } catch (_) {}
  const correlationId = payload.correlationId || job.correlation_id;
  const numeroVenda = payload.numeroVenda || job.numero_venda;
  db.prepare(
    `UPDATE fila_fiscal SET status = 'FALHA_PERMANENTE', erro = ? WHERE id = ?`,
  ).run(motivo, job.id);
  salvarResultadoEmissao(correlationId, numeroVenda, "FALHA_PERMANENTE", null, motivo);
  try {
    const fiscalAlertas = require("./fiscalAlertas");
    fiscalAlertas.alertarFalhaPermanente({
      correlationId,
      numeroVenda,
      motivo,
      jobId: job.id,
    });
  } catch (_) {}
  return { correlationId, numeroVenda, motivo };
}

function resetProximoRetryRecovery() {
  init();
  return db
    .prepare(
      `UPDATE fila_fiscal SET proximo_retry_at = datetime('now')
       WHERE tipo = 'EMISSAO' AND status IN ('INCERTO','RECUPERANDO')`,
    )
    .run().changes;
}

function listarUltimasEmissoes(limit = 10) {
  init();
  const rows = db
    .prepare(
      `SELECT correlation_id, numero_venda, status, atualizado_em, resultado
       FROM emissao_resultados ORDER BY datetime(atualizado_em) DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => {
    let chave = null;
    if (row.resultado) {
      try {
        chave = JSON.parse(row.resultado)?.chave || null;
      } catch (_) {}
    }
    if (!chave) {
      const doc = row.numero_venda
        ? buscarDocumentoPorVenda(row.numero_venda)
        : null;
      chave = doc?.chave || null;
    }
    return {
      numeroVenda: row.numero_venda,
      correlationId: row.correlation_id,
      status: row.status,
      timestamp: row.atualizado_em,
      chaveTruncada: chave ? `…${String(chave).slice(-8)}` : null,
    };
  });
}

function contarIncertosComBackoff() {
  init();
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM fila_fiscal
         WHERE tipo = 'EMISSAO' AND status IN ('INCERTO','RECUPERANDO')
           AND proximo_retry_at IS NOT NULL
           AND datetime(proximo_retry_at) > datetime('now')`,
      )
      .get().n || 0
  );
}

function purgeAntigos(diasFila = 30, diasResultados = 180, diasDocumentos = 180) {
  init();
  const rFila = db
    .prepare(
      `DELETE FROM fila_fiscal WHERE status = 'CONCLUIDO'
       AND datetime(criado_em) < datetime('now', ?)`,
    )
    .run(`-${diasFila} days`);
  const rRes = db
    .prepare(
      `DELETE FROM emissao_resultados WHERE status IN ('CONCLUIDO','CONCLUIDO_RECUPERADO','FALHA_PERMANENTE')
       AND datetime(atualizado_em) < datetime('now', ?)`,
    )
    .run(`-${diasResultados} days`);
  const rDoc = db
    .prepare(
      `DELETE FROM documentos_fiscais WHERE datetime(criado_em) < datetime('now', ?)`,
    )
    .run(`-${diasDocumentos || diasResultados} days`);
  return {
    filaRemovidos: rFila.changes,
    resultadosRemovidos: rRes.changes,
    documentosRemovidos: rDoc.changes,
  };
}

function descartarJobsGerarPdfPendentes(
  motivo = "PDF DANFC-e desabilitado (FISCAL_GERAR_PDF=false)",
) {
  init();
  const fiscalDriver = require("./fiscalDriver");
  const rows = db
    .prepare(
      `SELECT id, payload FROM fila_fiscal
       WHERE tipo = 'GERAR_PDF' AND status NOT IN ('CONCLUIDO','FALHA_PERMANENTE')`,
    )
    .all();
  let changes = 0;
  for (const row of rows) {
    let modelo = "65";
    try {
      const p = JSON.parse(row.payload);
      modelo =
        p.modeloDocumento ||
        (p.chave ? fiscalDriver.inferirModeloDaChave(p.chave) : null) ||
        "65";
    } catch (_) {}
    if (String(modelo) === "55") continue;
    db.prepare(
      `UPDATE fila_fiscal SET status = 'CONCLUIDO', erro = ? WHERE id = ?`,
    ).run(motivo, row.id);
    changes++;
  }
  return changes;
}

function cancelarEmissaoPendente(motivo = "Cancelado manualmente") {
  init();
  const r = db
    .prepare(
      `UPDATE fila_fiscal SET status = 'FALHA_PERMANENTE', erro = ?
       WHERE tipo = 'EMISSAO' AND status IN ('PENDENTE', 'INCERTO', 'PROCESSANDO','FALHA_TEMPORARIA')`,
    )
    .run(motivo);
  return r.changes;
}

function close() {
  pararWorkers();
  if (db) {
    try {
      db.close();
    } catch (_) {}
    db = null;
  }
}

function acbrOcupado() {
  try {
    const acbr = require("./acbr");
    if (acbr.isAcbrBusy()) return true;
  } catch (_) {}
  try {
    const emissionLock = require("./fiscal/fiscalEmissionLock");
    if (emissionLock.isEmissionInProgress()) return true;
  } catch (_) {}
  return processandoFiscal;
}

function estaEmEmissao() {
  return processandoFiscal;
}

function estaProcessando() {
  return processandoFiscal || processandoPdf;
}

module.exports = {
  TIPOS,
  STATUS,
  STATUS_ATIVOS,
  init,
  enfileirar,
  atualizarPayload,
  registrarHandler,
  iniciarWorker,
  pararWorkers,
  pausarFila,
  retomarFila,
  status,
  listar,
  salvarDocumento,
  buscarDocumentoPorChave,
  buscarDocumentoPorVenda,
  buscarDocumentoPorSerieNumero,
  salvarResultadoEmissao,
  obterResultadoEmissao,
  obterResultadoPorVenda,
  consultarStatusEmissao,
  consultarStatusEmissaoPorVenda,
  obterJobEmissao,
  aguardarConclusao,
  reprocessarIncertos,
  vendaTemJobAtivo,
  vendaJaConcluida,
  recuperarBoot,
  purgeAntigos,
  cancelarEmissaoPendente,
  descartarJobsGerarPdfPendentes,
  marcarJob,
  buscarJobEmissaoPorVenda,
  dispararProcessamento,
  aguardarJobsAtivos,
  contadoresAlertas,
  ultimoDocumentoXml,
  listarJobsRecoveryProntos,
  agendarRetryConsulta,
  marcarFalhaConsultaTimeout,
  contarIncertosComBackoff,
  resetProximoRetryRecovery,
  listarUltimasEmissoes,
  liberarJobsTravados,
  close,
  estaProcessando,
  estaEmEmissao,
  acbrOcupado,
};
