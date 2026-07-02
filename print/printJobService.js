/**
 * PrintJobService — fila persistente, retry, timeout, auditoria (Frente 13).
 * Toda impressão do agente passa por aqui via printerService.js.
 */
const log = require("../logger").child({ modulo: "print_job_service" });
const store = require("./printJobStore");
const printLog = require("./printJobLog");
const { executarOp, classifyPrintError } = require("./printExecutor");
const { resolverTipo, extrairMeta, STATUS } = require("./printJobTypes");

let workerTimer = null;
let processando = false;
let printLock = Promise.resolve();

const stats = {
  jobsProcessados: 0,
  retries: 0,
  ultimoErro: null,
  ultimaImpressaoEm: null,
};

function cfg() {
  return {
    maxTentativas: parseInt(process.env.PRINT_JOB_MAX_TENTATIVAS || "5", 10),
    timeoutTotalMs: parseInt(process.env.PRINT_JOB_TIMEOUT_TOTAL_MS || "20000", 10),
    backoffBaseMs: parseInt(process.env.PRINT_JOB_BACKOFF_MS || "2000", 10),
    pollMs: parseInt(process.env.PRINT_JOB_POLL_MS || "1000", 10),
    retentionDias: parseInt(process.env.PRINT_JOB_RETENTION_DIAS || "90", 10),
  };
}

function serializarPayload(args) {
  return JSON.stringify({ args: args || [] });
}

function parsePayload(json) {
  try {
    const o = JSON.parse(json);
    return Array.isArray(o.args) ? o.args : [];
  } catch {
    return [];
  }
}

function withPrintLock(fn) {
  const run = printLock.then(() => fn());
  printLock = run.catch(() => {});
  return run;
}

function calcBackoff(tentativa) {
  const base = cfg().backoffBaseMs;
  return Math.min(base * Math.pow(2, Math.max(0, tentativa - 1)), 60000);
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tipo: row.tipo,
    op: row.op,
    status: row.status,
    documento: row.documento,
    numeroVenda: row.numero_venda,
    usuario: row.usuario,
    caixa: row.caixa,
    tenantId: row.tenant_id,
    tentativas: row.tentativas,
    maxTentativas: row.max_tentativas,
    provider: row.provider,
    driver: row.driver,
    porta: row.porta,
    modelo: row.modelo,
    duracaoMs: row.duracao_ms,
    bytesEnviados: row.bytes_enviados,
    erro: row.erro,
    motivo: row.motivo,
    jobPaiId: row.job_pai_id,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    impressoEm: row.impresso_em,
  };
}

function enfileirar(op, args, opts = {}) {
  store.initDb();
  const { validarAntesEnfileirar } = require("./printValidate");
  const validado = validarAntesEnfileirar(op, args);
  args = validado.args;
  const payload = args?.[0];
  const meta = extrairMeta(payload, opts);
  const id = store.novoId();
  const c = cfg();
  const row = {
    id,
    tipo: resolverTipo(op, payload),
    op,
    status: STATUS.PENDENTE,
    payload_json: serializarPayload(args),
    documento: meta.documento,
    numero_venda: meta.numeroVenda,
    usuario: meta.usuario,
    caixa: meta.caixa,
    tenant_id: meta.tenantId,
    tentativas: 0,
    max_tentativas: opts.maxTentativas || c.maxTentativas,
    proxima_tentativa_em: null,
    motivo: meta.motivo || opts.motivo || null,
    job_pai_id: opts.jobPaiId || null,
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };
  store.inserirJob(row);
  store.registrarEvento(id, "CRIADO", `${op} · ${row.tipo}`);
  store.registrarEvento(id, "VALIDADO", "payload ok");
  printLog.registrar({ jobId: id, op, tipo: row.tipo, status: STATUS.PENDENTE, evento: "enfileirado" });
  log.info({ jobId: id, op, tipo: row.tipo }, "[PrintJob] Enfileirado");
  agendarWorker();
  return rowToJob(store.buscarJob(id));
}

async function processarJobRow(row) {
  const args = parsePayload(row.payload_json);
  store.atualizarJob(row.id, { status: STATUS.ENVIANDO, tentativas: row.tentativas + 1 });
  store.registrarEvento(row.id, "ENVIANDO", `tentativa ${row.tentativas + 1}`);

  try {
    const exec = await executarOp(row.op, args, cfg().timeoutTotalMs);
    store.atualizarJob(row.id, {
      status: STATUS.IMPRESSO,
      provider: exec.provider,
      driver: exec.driver,
      porta: exec.porta,
      modelo: exec.modelo,
      duracao_ms: exec.durationMs,
      bytes_enviados: exec.bytesEnviados,
      erro: null,
      impresso_em: new Date().toISOString(),
      proxima_tentativa_em: null,
    });
    store.registrarEvento(row.id, "IMPRESSO", `${exec.durationMs}ms`);
    printLog.registrar({
      jobId: row.id,
      op: row.op,
      tipo: row.tipo,
      status: STATUS.IMPRESSO,
      durationMs: exec.durationMs,
      provider: exec.provider,
      driver: exec.driver,
      porta: exec.porta,
      modelo: exec.modelo,
      bytesEnviados: exec.bytesEnviados,
    });
    stats.jobsProcessados += 1;
    stats.ultimaImpressaoEm = new Date().toISOString();
    stats.ultimoErro = null;
    log.info({ jobId: row.id, op: row.op, ms: exec.durationMs }, "[PrintJob] Impresso");
    return { ok: true, job: rowToJob(store.buscarJob(row.id)), result: exec.result };
  } catch (err) {
    const cls = classifyPrintError(err);
    const tentativas = row.tentativas + 1;
    const maxT = row.max_tentativas || cfg().maxTentativas;
    stats.ultimoErro = err.message;

    if (cls.retryable && tentativas < maxT) {
      const delay = calcBackoff(tentativas);
      store.atualizarJob(row.id, {
        status: STATUS.REPROCESSANDO,
        tentativas,
        erro: err.message,
        proxima_tentativa_em: Date.now() + delay,
      });
      store.registrarEvento(row.id, "RETRY", `${tentativas}/${maxT} em ${delay}ms`);
      printLog.registrar({
        jobId: row.id,
        op: row.op,
        status: STATUS.REPROCESSANDO,
        erro: err.message,
        tentativa: tentativas,
      });
      stats.retries += 1;
      try {
        require("./factory").resetPrintProvider();
      } catch (_) {}
      log.warn({ jobId: row.id, err: err.message, tentativas, delay }, "[PrintJob] Retry agendado");
      return { ok: false, retry: true, job: rowToJob(store.buscarJob(row.id)) };
    }

    store.atualizarJob(row.id, {
      status: STATUS.ERRO,
      tentativas,
      erro: err.message,
      proxima_tentativa_em: null,
    });
    store.registrarEvento(row.id, "ERRO", err.message);
    printLog.registrar({
      jobId: row.id,
      op: row.op,
      status: STATUS.ERRO,
      erro: err.message,
      permanente: cls.permanente,
    });
    log.error({ jobId: row.id, err: err.message }, "[PrintJob] Falha definitiva");
    try {
      const factory = require("./factory");
      if (cls.retryable) factory.resetPrintProvider();
    } catch (_) {}
    return { ok: false, retry: false, job: rowToJob(store.buscarJob(row.id)), erro: err.message };
  }
}

async function processarFila() {
  if (processando) return { processados: 0 };
  processando = true;
  let processados = 0;
  try {
    await withPrintLock(async () => {
      for (let i = 0; i < 20; i++) {
        const row = store.proximoJobPronto();
        if (!row) break;
        await processarJobRow(row);
        processados += 1;
      }
    });
  } finally {
    processando = false;
  }
  return { processados };
}

function agendarWorker() {
  if (workerTimer) return;
  workerTimer = setTimeout(async () => {
    workerTimer = null;
    try {
      await processarFila();
    } catch (err) {
      log.warn({ err: err.message }, "[PrintJob] Worker falhou");
    }
    const pendentes = store.contadores();
    if (pendentes.pendente + pendentes.reprocessando > 0) {
      agendarWorker();
    }
  }, 0);
}

function iniciarWorker() {
  store.initDb();
  try {
    store.purgeAntigos(cfg().retentionDias);
  } catch (_) {}
  if (process.env.PRINT_JOB_WORKER === "false") return;
  setInterval(() => {
    processarFila().catch(() => {});
  }, cfg().pollMs);
  processarFila().catch(() => {});
}

/**
 * Submete impressão: enfileira e aguarda conclusão (ou fila de retry).
 */
async function submitPrint(op, args, opts = {}) {
  const job = enfileirar(op, args, opts);
  if (opts.async === true) {
    return { jobId: job.id, job, async: true };
  }

  const deadline = Date.now() + (opts.waitTimeoutMs || cfg().timeoutTotalMs * cfg().maxTentativas + 30000);
  while (Date.now() < deadline) {
    await processarFila();
    const atual = store.buscarJob(job.id);
    if (!atual) break;
    if (atual.status === STATUS.IMPRESSO) {
      return { ok: true, jobId: job.id, job: rowToJob(atual) };
    }
    if (atual.status === STATUS.ERRO) {
      const e = new Error(atual.erro || "Falha na impressão");
      e.jobId = job.id;
      throw e;
    }
    if (atual.status === STATUS.REPROCESSANDO || atual.status === STATUS.PENDENTE) {
      await new Promise((r) => setTimeout(r, Math.min(cfg().pollMs, 500)));
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const pendente = store.buscarJob(job.id);
  if (pendente && (pendente.status === STATUS.REPROCESSANDO || pendente.status === STATUS.PENDENTE)) {
    return {
      ok: false,
      queued: true,
      jobId: job.id,
      job: rowToJob(pendente),
      message: "Impressão na fila — será reenviada automaticamente.",
    };
  }
  throw new Error("Timeout aguardando impressão");
}

function reprocessar(jobId) {
  const row = store.buscarJob(jobId);
  if (!row) throw new Error("Job de impressão não encontrado.");
  if (row.status === STATUS.CANCELADO) throw new Error("Job cancelado.");
  store.atualizarJob(jobId, {
    status: STATUS.PENDENTE,
    proxima_tentativa_em: null,
    erro: null,
  });
  store.registrarEvento(jobId, "REPROCESSAR_MANUAL", null);
  agendarWorker();
  return rowToJob(store.buscarJob(jobId));
}

function reimprimir(jobId, opts = {}) {
  const row = store.buscarJob(jobId);
  if (!row) throw new Error("Job de impressão não encontrado.");
  const args = parsePayload(row.payload_json);
  return enfileirar(row.op, args, {
    ...opts,
    jobPaiId: jobId,
    motivo: opts.motivo || "reimpressao",
  });
}

function cancelar(jobId) {
  store.atualizarJob(jobId, { status: STATUS.CANCELADO, proxima_tentativa_em: null });
  store.registrarEvento(jobId, "CANCELADO", null);
  return rowToJob(store.buscarJob(jobId));
}

function observabilidade() {
  store.initDb();
  const c = store.contadores();
  const ultimoOk = store.ultimoJobImpresso();
  const ultimoErr = store.ultimoJobErro();
  return {
    fila: c,
    tempoMedioMs: store.tempoMedioMs(),
    tempoMaximoMs: store.tempoMaximoMs(),
    porTipo: store.metricasPorTipo(),
    ultimaImpressao: ultimoOk ? rowToJob(ultimoOk) : null,
    ultimoErro: ultimoErr ? rowToJob(ultimoErr) : null,
    stats: { ...stats },
    workerAtivo: process.env.PRINT_JOB_WORKER !== "false",
  };
}

module.exports = {
  cfg,
  iniciarWorker,
  enfileirar,
  submitPrint,
  processarFila,
  reprocessar,
  reimprimir,
  cancelar,
  listarJobs: (opts) => store.listarJobs(opts).map(rowToJob),
  buscarJob: (id) => rowToJob(store.buscarJob(id)),
  observabilidade,
  STATUS,
};
