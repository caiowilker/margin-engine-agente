/**
 * PrintJobService — fila persistente, retry, timeout, auditoria (Frente 13).
 * Toda impressão do agente passa por aqui via printerService.js.
 */
const log = require("../logger").child({ modulo: "print_job_service" });
const store = require("./printJobStore");
const printLog = require("./printJobLog");
const { classifyPrintError } = require("./printExecutor");
const { resolverTipo, extrairMeta, STATUS } = require("./printJobTypes");
const {
  resolveIdempotencyKey,
  deveDeduplicar,
} = require("./printIdempotency");

function getExecutarOp() {
  // Lazy: permite testes monkeypatcharem printExecutor.executarOp
  return require("./printExecutor").executarOp;
}

let workerTimer = null;
let processando = false;
let printLock = Promise.resolve();
/** Jobs físicos em voo — probes de status não devem abrir sessão/ACBr nesse momento. */
let jobsEmVoo = 0;

const stats = {
  jobsProcessados: 0,
  retries: 0,
  ultimoErro: null,
  ultimaImpressaoEm: null,
};

function cfg() {
  return {
    maxTentativas: parseInt(process.env.PRINT_JOB_MAX_TENTATIVAS || "5", 10),
    // Soft curto: PDV comercial — falha limpa < ~6s (soft+drain), nunca minutos.
    timeoutTotalMs: parseInt(process.env.PRINT_JOB_TIMEOUT_TOTAL_MS || "10000", 10),
    // Soft ≥ ACBR_POS_CALL (~4500) + margem — evita hard-drain antes do worker responder.
    timeoutFastMs: parseInt(process.env.PRINT_JOB_TIMEOUT_FAST_MS || "6500", 10),
    backoffBaseMs: parseInt(process.env.PRINT_JOB_BACKOFF_MS || "500", 10),
    pollMs: parseInt(process.env.PRINT_JOB_POLL_MS || "400", 10),
    retentionDias: parseInt(process.env.PRINT_JOB_RETENTION_DIAS || "90", 10),
  };
}

function isTipoRapido(tipo) {
  return (
    tipo === "cupom_nao_fiscal" ||
    tipo === "cupom_fiscal" ||
    tipo === "danfe_termico" ||
    tipo === "segunda_via" ||
    tipo === "abertura_caixa" ||
    tipo === "fechamento_caixa" ||
    tipo === "movimento_caixa" ||
    tipo === "sangria" ||
    tipo === "suprimento" ||
    tipo === "pedido_comanda" ||
    tipo === "vasilhame_emprestimo" ||
    tipo === "crediario_recebimento" ||
    tipo === "etiqueta_termica" ||
    tipo === "teste" ||
    tipo === "gaveta"
  );
}

/**
 * Menor = mais urgente.
 * 0 gaveta · 1 pedido/comanda · 2 cupom/caixa/DANFE/vasilhame/crediário · 5 demais
 */
function prioridadeParaJob(tipo, payload) {
  if (tipo === "gaveta") return 0;
  if (tipo === "pedido_comanda") return 1;
  if (
    tipo === "cupom_nao_fiscal" ||
    tipo === "cupom_fiscal" ||
    tipo === "danfe_termico" ||
    tipo === "segunda_via" ||
    tipo === "abertura_caixa" ||
    tipo === "fechamento_caixa" ||
    tipo === "movimento_caixa" ||
    tipo === "sangria" ||
    tipo === "suprimento" ||
    tipo === "vasilhame_emprestimo" ||
    tipo === "crediario_recebimento" ||
    tipo === "etiqueta_termica"
  ) {
    return 2;
  }
  const ev = String(payload?.eventType || payload?.event_type || "").toUpperCase();
  if (ev === "PRE_CONTA" || ev === "BILL_REQUESTED") return 1;
  return 5;
}

function agendarWarmPosSeRapido(tipo) {
  if (!isTipoRapido(tipo) || tipo === "teste") return;
  setImmediate(() => {
    try {
      const core = require("./escpos/impressoraCore");
      // Já quente ou impressão em voo — não disparar sharp/Add-Type contra o cupom.
      if (typeof core.isPrintHotPathReady === "function" && core.isPrintHotPathReady()) {
        if (typeof core.isLogoEscposReady === "function" && core.isLogoEscposReady()) {
          return;
        }
      }
      if (typeof core.isWarmHotPathInFlight === "function" && core.isWarmHotPathInFlight()) {
        return;
      }
      if (impressaoEmAndamento()) return;
    } catch (_) {}
    try {
      const runtime = require("./acbrPosPrinterRuntime");
      if (typeof runtime.extendPosPrinterSessionIdle === "function") {
        runtime.extendPosPrinterSessionIdle();
      }
    } catch (_) {
      /* warm opcional */
    }
    try {
      const core = require("./escpos/impressoraCore");
      if (typeof core.warmPrintHotPath === "function") {
        void core.warmPrintHotPath().catch(() => {});
      }
    } catch (_) {
      /* logo warm opcional */
    }
  });
}

function calcBackoff(tentativa) {
  const base = cfg().backoffBaseMs;
  // Jobs rápidos: teto curto (não esperar 60s no salão).
  return Math.min(base * Math.pow(2, Math.max(0, tentativa - 1)), 5000);
}

function timeoutParaJob(row) {
  const c = cfg();
  // Gaveta = 5 bytes ESC/POS — soft curto para PDV sentir instantâneo.
  if (row.tipo === "gaveta" || row.op === "abrirGaveta") {
    const gavetaMs = parseInt(process.env.PRINT_JOB_TIMEOUT_GAVETA_MS || "2500", 10);
    return Math.min(c.timeoutFastMs, Number.isFinite(gavetaMs) ? Math.max(800, gavetaMs) : 2500);
  }
  // PPLA com várias cópias = N WritePrinter — margem por cópia.
  if (row.tipo === "etiqueta_termica" || row.op === "imprimirRaw") {
    let copies = 1;
    try {
      const args = parsePayload(row.payload_json);
      copies = Math.max(1, parseInt(args?.[0]?.copies || 1, 10) || 1);
    } catch (_) {}
    const base = c.timeoutFastMs;
    return Math.min(c.timeoutTotalMs, base + Math.min(copies, 20) * 400);
  }
  if (isTipoRapido(row.tipo)) return c.timeoutFastMs;
  return c.timeoutTotalMs;
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
  const idempotencyKey = resolveIdempotencyKey(op, args, opts);

  if (idempotencyKey) {
    const existing = store.buscarPorIdempotencyKey(idempotencyKey);
    if (existing && deveDeduplicar(existing)) {
      store.registrarEvento(
        existing.id,
        "DEDUP",
        `chave=${idempotencyKey} status=${existing.status}`,
      );
      log.info(
        { jobId: existing.id, idempotencyKey, status: existing.status },
        "[PrintJob] Deduplicado — sem reimpressão",
      );
      return { ...rowToJob(existing), deduplicado: true, idempotencyKey };
    }
    // ERRO/CANCELADO/IMPRESSO expirado: libera a UNIQUE key para novo envio (senão
    // INSERT falha e devolve o job morto — PDV fica “preso” após falha transitória).
    if (existing && !deveDeduplicar(existing)) {
      store.atualizarJob(existing.id, { idempotency_key: null });
      store.registrarEvento(
        existing.id,
        "IDEMPOTENCY_RELEASE",
        `chave=${idempotencyKey} status=${existing.status}`,
      );
    }
  }

  const id = store.novoId();
  const c = cfg();
  const tipo = resolverTipo(op, payload);
  const row = {
    id,
    tipo,
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
    idempotency_key: idempotencyKey,
    prioridade: prioridadeParaJob(tipo, payload),
  };
  try {
    store.inserirJob(row);
  } catch (err) {
    // Corrida: outro request inseriu a mesma chave.
    if (idempotencyKey && /UNIQUE|constraint/i.test(String(err.message || ""))) {
      const existing = store.buscarPorIdempotencyKey(idempotencyKey);
      if (existing) {
        log.info(
          { jobId: existing.id, idempotencyKey },
          "[PrintJob] Deduplicado (race UNIQUE)",
        );
        return { ...rowToJob(existing), deduplicado: true, idempotencyKey };
      }
    }
    throw err;
  }
  store.registrarEvento(id, "CRIADO", `${op} · ${row.tipo}`);
  store.registrarEvento(id, "VALIDADO", "payload ok");
  if (idempotencyKey) {
    store.registrarEvento(id, "IDEMPOTENCY", idempotencyKey);
  }
  const clickIdAudit = String(payload?.clickId || payload?.click_id || "").trim();
  const reimpressaoAudit =
    payload?.reimpressao === true ||
    clickIdAudit.length > 0 ||
    /reimpress|segunda/.test(String(payload?.motivo || meta.motivo || "").toLowerCase());
  if (reimpressaoAudit) {
    store.registrarEvento(
      id,
      "REIMPRESSAO_AUDIT",
      JSON.stringify({
        clickId: clickIdAudit || null,
        motivo: meta.motivo || payload?.motivo || "reimpressao",
        usuario: meta.usuario || null,
        documento: meta.documento || null,
        numeroVenda: meta.numeroVenda || null,
        at: new Date().toISOString(),
      }),
    );
    log.info(
      {
        jobId: id,
        clickId: clickIdAudit || null,
        motivo: meta.motivo || payload?.motivo || null,
        usuario: meta.usuario || null,
        documento: meta.documento || null,
      },
      "[PrintJob] Auditoria 2ª via",
    );
  }
  printLog.registrar({ jobId: id, op, tipo: row.tipo, status: STATUS.PENDENTE, evento: "enfileirado" });
  log.info(
    { jobId: id, op, tipo: row.tipo, prioridade: row.prioridade, idempotencyKey },
    "[PrintJob] Enfileirado",
  );
  agendarWarmPosSeRapido(row.tipo);
  agendarWorker();
  return { ...rowToJob(store.buscarJob(id)), deduplicado: false, idempotencyKey };
}

async function processarJobRow(row) {
  const args = parsePayload(row.payload_json);
  store.atualizarJob(row.id, { status: STATUS.ENVIANDO, tentativas: row.tentativas + 1 });
  store.registrarEvento(row.id, "ENVIANDO", `tentativa ${row.tentativas + 1}`);

  jobsEmVoo += 1;
  try {
    const exec = await getExecutarOp()(row.op, args, timeoutParaJob(row));
    // Anti sucesso fantasma: se o job já saiu de ENVIANDO (reclaim/erro paralelo), não promover.
    const atual = store.buscarJob(row.id);
    if (atual && atual.status !== STATUS.ENVIANDO) {
      log.warn(
        {
          jobId: row.id,
          status: atual.status,
          durationMs: exec.durationMs,
          metric: "print.late_abandoned",
        },
        "[PrintJob] Envio concluiu tarde — status já finalizado; sem promover IMPRESSO",
      );
      return { ok: false, abandoned: true, job: rowToJob(atual), result: exec.result };
    }
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
    const enqueueAt = row.criado_em ? Date.parse(row.criado_em) : NaN;
    const enqueueToDoneMs = Number.isFinite(enqueueAt)
      ? Math.max(0, Date.now() - enqueueAt)
      : null;
    const resultMeta =
      exec.result && typeof exec.result === "object" ? exec.result : {};
    log.info(
      {
        jobId: row.id,
        op: row.op,
        tipo: row.tipo,
        metric: "print.job_e2e",
        enqueueToDoneMs,
        execMs: exec.durationMs,
        provider: exec.provider,
        backend: resultMeta.backend || resultMeta.rawBackend || null,
        rawTotalMs: resultMeta.timings?.totalMs ?? resultMeta.sendMs ?? null,
        bytes: exec.bytesEnviados,
        slow:
          (enqueueToDoneMs != null && enqueueToDoneMs > 1000) ||
          (exec.durationMs != null && exec.durationMs > 500),
      },
      "[PrintJob] E2E enqueue→impresso",
    );
    if (enqueueToDoneMs != null && enqueueToDoneMs > 1000) {
      log.warn(
        {
          metric: "print.job_e2e_slow",
          jobId: row.id,
          enqueueToDoneMs,
          thresholdMs: 1000,
          op: row.op,
        },
        "[PrintJob] E2E >1s — regressão de latência",
      );
    }
    log.info(
      { jobId: row.id, op: row.op, ms: exec.durationMs, metric: "print.duration_ms", provider: exec.provider },
      "[PrintJob] Impresso",
    );
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
        if (/(-10)|porta|PRINTER_PORTA/i.test(String(err?.message || ""))) {
          require("./printerBootstrap")
            .garantirPortaImpressao({ force: tentativas >= 2 })
            .catch(() => {});
        }
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
  } finally {
    jobsEmVoo = Math.max(0, jobsEmVoo - 1);
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
    const recuperados = store.recuperarJobsEnviandoPresos();
    if (recuperados > 0) {
      log.warn({ recuperados }, "[PrintJob] Jobs ENVIANDO recuperados após reinício");
    }
  } catch (err) {
    log.warn({ err: err.message }, "[PrintJob] Falha ao recuperar jobs ENVIANDO");
  }
  try {
    const { portaAcbrValida } = require("./printerModelMap");
    const cfg = require("./printerLocalConfig").ler();
    if (!portaAcbrValida(cfg.porta)) {
      require("./printerBootstrap")
        .autoDetectarESincronizar({ force: false })
        .catch(() => {});
    }
  } catch (_) {}
  try {
    store.purgeAntigos(cfg().retentionDias);
  } catch (_) {}
  if (process.env.PRINT_JOB_WORKER === "false") return;
  setInterval(() => {
    try {
      // Não reclaim enquanto job físico em voo ou envio abandonado ainda vivo
      if (impressaoEmAndamento()) {
        processarFila().catch(() => {});
        return;
      }
      // Soft+drain+buffer (~15–30s). 90s deixava ENVIANDO “preso” demais no PDV.
      store.recuperarJobsEnviandoPresos(
        parseInt(process.env.PRINT_ENVIANDO_STALE_MS || "25000", 10),
      );
    } catch (_) {}
    processarFila().catch(() => {});
  }, cfg().pollMs);
  processarFila().catch(() => {});
}

/**
 * Submete impressão: enfileira e aguarda conclusão (ou fila de retry).
 * Deduplica por idempotency key — retry/timeout não reimprime.
 */
async function submitPrint(op, args, opts = {}) {
  const job = enfileirar(op, args, opts);
  if (job.deduplicado && job.status === STATUS.IMPRESSO) {
    return {
      ok: true,
      jobId: job.id,
      job,
      deduplicado: true,
    };
  }
  if (opts.async === true) {
    return { jobId: job.id, job, async: true, deduplicado: !!job.deduplicado };
  }

  const deadline = Date.now() + (opts.waitTimeoutMs || cfg().timeoutTotalMs * cfg().maxTentativas + 30000);
  while (Date.now() < deadline) {
    await processarFila();
    const atual = store.buscarJob(job.id);
    if (!atual) break;
    if (atual.status === STATUS.IMPRESSO) {
      return {
        ok: true,
        jobId: job.id,
        job: rowToJob(atual),
        deduplicado: !!job.deduplicado,
      };
    }
    if (atual.status === STATUS.ERRO) {
      const e = new Error(atual.erro || "Falha na impressão");
      e.jobId = job.id;
      throw e;
    }
    if (atual.status === STATUS.REPROCESSANDO || atual.status === STATUS.PENDENTE || atual.status === STATUS.ENVIANDO) {
      await new Promise((r) => setTimeout(r, Math.min(cfg().pollMs, 500)));
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const pendente = store.buscarJob(job.id);
  if (pendente && (pendente.status === STATUS.REPROCESSANDO || pendente.status === STATUS.PENDENTE || pendente.status === STATUS.ENVIANDO)) {
    return {
      ok: false,
      queued: true,
      jobId: job.id,
      job: rowToJob(pendente),
      deduplicado: !!job.deduplicado,
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
  // force:true — reimpressão manual NÃO deve herdar idempotency_key do original.
  return enfileirar(row.op, args, {
    ...opts,
    force: true,
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

const RECENT_OK_WINDOW_MS = parseInt(
  process.env.PRINTER_RECENT_OK_WINDOW_MS || "900000",
  10,
);

/**
 * Retorna true se houve impressão bem-sucedida nos últimos windowMs ms.
 * Fonte de verdade unificada: status baseado no pipeline real de impressão,
 * não num probe de conectividade paralelo que pode falhar independentemente.
 */
function impressaoRecenteOk(windowMs) {
  const janela = windowMs ?? RECENT_OK_WINDOW_MS;
  if (stats.ultimaImpressaoEm) {
    const age = Date.now() - new Date(stats.ultimaImpressaoEm).getTime();
    if (age < janela) return true;
  }
  try {
    store.initDb();
    const ultimo = store.ultimoJobImpresso();
    if (ultimo?.impresso_em) {
      const age = Date.now() - new Date(ultimo.impresso_em).getTime();
      if (age < janela) return true;
    }
  } catch (_) {}
  return false;
}

function impressaoEmAndamento() {
  if (jobsEmVoo > 0 || processando) return true;
  try {
    return require("./printExecutor").physicalSendAbandonedInFlight();
  } catch (_) {
    return false;
  }
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
  impressaoRecenteOk,
  impressaoEmAndamento,
  STATUS,
};
