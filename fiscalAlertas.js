// Alertas push via webhook — fire-and-forget, nunca bloqueia fluxo fiscal
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "fiscal_alertas" });

const WEBHOOK_URL = process.env.WEBHOOK_ALERTAS_URL || "";
const ALERTA_INCERTOS_MAX = parseInt(process.env.ALERTA_INCERTOS_MAX || "5", 10);
const RELATORIO_WEBHOOK_URL = process.env.RELATORIO_WEBHOOK_URL || "";
const RELATORIO_HORARIO = process.env.RELATORIO_HORARIO || "23:59";

const FILA_PENDENTE_ALERTA_THRESHOLD = parseInt(
  process.env.FILA_PENDENTE_ALERTA_THRESHOLD || "10",
  10,
);
const FILA_PENDENTE_IDADE_MIN = parseInt(process.env.FILA_PENDENTE_IDADE_MIN || "15", 10);
const CSTAT_999_RATE_WINDOW_MIN = parseInt(process.env.CSTAT_999_RATE_WINDOW_MIN || "10", 10);
const CSTAT_999_RATE_MAX = parseInt(process.env.CSTAT_999_RATE_MAX || "5", 10);
const ALERTA_MONITOR_INTERVAL_MS = parseInt(process.env.ALERTA_MONITOR_INTERVAL_MS || "60000", 10);

let ultimoAcbrStatus = null;
let ultimoDiscoCritico = false;
let alertasDispatchados = 0;
let relatorioTimer = null;
let monitorTimer = null;
const estadoFilas = new Map();
const estadoFilaSustentada = new Map();
let estadoCStat999 = { alertado: false };

function agenteUrl() {
  const port = process.env.AGENT_PORT || process.env.PORT || "9100";
  const host = process.env.AGENT_PUBLIC_HOST || "http://127.0.0.1";
  if (host.startsWith("http")) return `${host.replace(/\/$/, "")}:${port}`.replace(/:(\d+):\d+$/, ":$1");
  return `http://${host}:${port}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function enviarWebhook(tipo, mensagem, dados = {}) {
  if (!WEBHOOK_URL) return;
  const payload = {
    tipo,
    mensagem,
    dados,
    agente: agenteUrl(),
    timestamp: new Date().toISOString(),
  };
  setImmediate(async () => {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const fetch = require("node-fetch");
        const resp = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          timeout: 8000,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        alertasDispatchados++;
        try {
          auditLog.registrar("WEBHOOK_ALERTA_OK", { tipo, tentativa });
        } catch (_) {}
        return;
      } catch (err) {
        if (tentativa === 3) {
          try {
            auditLog.registrar("WEBHOOK_ALERTA_FALHA", {
              tipo,
              err: err.message,
            });
          } catch (_) {}
          log.warn({ tipo, err: err.message }, "Webhook alerta falhou após 3 tentativas");
        } else {
          await sleep(5000);
        }
      }
    }
  });
}

function logCritico(tipo, mensagem, dados = {}) {
  log.fatal({ tipo, ...dados }, mensagem);
  try {
    auditLog.registrar("ALERTA_CRITICO", { tipo, mensagem, ...dados });
  } catch (_) {}
}

async function enviarRelatorioWebhook(relatorio) {
  if (!RELATORIO_WEBHOOK_URL) return;
  setImmediate(async () => {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const fetch = require("node-fetch");
        const resp = await fetch(RELATORIO_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tipo: "RELATORIO_DIARIO",
            mensagem: `Relatório fiscal ${relatorio.data}`,
            dados: relatorio,
            agente: agenteUrl(),
            timestamp: new Date().toISOString(),
          }),
          timeout: 10000,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        try {
          auditLog.registrar("WEBHOOK_RELATORIO_OK", { data: relatorio.data });
        } catch (_) {}
        return;
      } catch (err) {
        if (tentativa === 3) {
          try {
            auditLog.registrar("WEBHOOK_RELATORIO_FALHA", { err: err.message });
          } catch (_) {}
        } else {
          await sleep(5000);
        }
      }
    }
  });
}

function alertarFalhaPermanente(jobInfo) {
  void enviarWebhook(
    "FALHA_PERMANENTE",
    `Job ${jobInfo.numeroVenda || jobInfo.correlationId} falhou definitivamente`,
    jobInfo,
  );
}

function verificarIncertos(incertos) {
  if (incertos > ALERTA_INCERTOS_MAX) {
    void enviarWebhook(
      "INCERTOS_ELEVADOS",
      `${incertos} jobs INCERTO/RECUPERANDO (limite ${ALERTA_INCERTOS_MAX})`,
      { incertos, limite: ALERTA_INCERTOS_MAX },
    );
  }
}

function onAcbrStatusChange(novoStatus) {
  const anterior = ultimoAcbrStatus;
  ultimoAcbrStatus = novoStatus;
  if (anterior === null) return;
  if (novoStatus === "offline" && anterior !== "offline") {
    void enviarWebhook(
      "ACBR_OFFLINE",
      "ACBr mudou para offline",
      { statusAnterior: anterior, statusAtual: novoStatus },
    );
    try {
      auditLog.registrar("ACBR_STATUS_OFFLINE", { anterior, novo: novoStatus });
    } catch (_) {}
  }
}

function verificarDiscoCritico(espacoDisco) {
  if (!espacoDisco) return;
  const critico = ["xml", "pdf", "backup"].some(
    (k) => espacoDisco[k]?.status === "critico",
  );
  if (critico && !ultimoDiscoCritico) {
    ultimoDiscoCritico = true;
    void enviarWebhook("DISCO_CRITICO", "Espaço em disco crítico", espacoDisco);
  } else if (!critico) {
    ultimoDiscoCritico = false;
  }
}

function verificarFila(nome, snapshot) {
  if (!nome || !snapshot) return;
  const total = Number(snapshot.total ?? 0);
  const warn = Number(snapshot.limiteAviso ?? 0);
  const critical = Number(snapshot.limiteCritico ?? 0);
  const status =
    critical > 0 && total >= critical
      ? "critico"
      : warn > 0 && total >= warn
        ? "alerta"
        : "ok";
  const anterior = estadoFilas.get(nome) || "ok";
  estadoFilas.set(nome, status);
  if (status === "ok" || status === anterior) return;
  void enviarWebhook(
    "FILA_CRESCENDO",
    `Fila ${nome} em ${status} (${total} item(ns))`,
    {
      nome,
      status,
      total,
      limiteAviso: warn || null,
      limiteCritico: critical || null,
      oldestAgeMinutes: snapshot.oldestAgeMinutes ?? null,
      detalhes: snapshot,
    },
  );
  try {
    auditLog.registrar("FILA_ALERTA", {
      nome,
      status,
      total,
      limiteAviso: warn || null,
      limiteCritico: critical || null,
    });
  } catch (_) {}
}

function quantidadePendente(snapshot) {
  if (!snapshot) return 0;
  if (snapshot.pendentes != null && snapshot.total != null && snapshot.pendentes !== snapshot.total) {
    return Number(snapshot.pendentes);
  }
  return Number(snapshot.pendentes ?? snapshot.total ?? 0);
}

function verificarFilaPendenteSustentada(nome, snapshot) {
  if (!nome || !snapshot) return;
  const qtd = quantidadePendente(snapshot);
  const idade = Number(snapshot.oldestAgeMinutes ?? 0);
  const condicao =
    qtd > FILA_PENDENTE_ALERTA_THRESHOLD &&
    idade >= FILA_PENDENTE_IDADE_MIN;
  const anterior = estadoFilaSustentada.get(nome) || { alertado: false };

  if (condicao) {
    if (!anterior.alertado) {
      const mensagem = `Fila ${nome}: ${qtd} pendente(s) há ${idade} min (limite ${FILA_PENDENTE_ALERTA_THRESHOLD} / ${FILA_PENDENTE_IDADE_MIN} min)`;
      const dados = {
        nome,
        pendentes: qtd,
        oldestAgeMinutes: idade,
        limiteQuantidade: FILA_PENDENTE_ALERTA_THRESHOLD,
        limiteMinutos: FILA_PENDENTE_IDADE_MIN,
        detalhes: snapshot,
      };
      logCritico("FILA_PENDENTE_SUSTENTADA", mensagem, dados);
      void enviarWebhook("FILA_PENDENTE_SUSTENTADA", mensagem, dados);
    }
    estadoFilaSustentada.set(nome, { alertado: true, desde: anterior.desde || Date.now() });
  } else {
    estadoFilaSustentada.set(nome, { alertado: false });
  }
}

function verificarTaxaCStat999() {
  let fiscalMetrics;
  try {
    fiscalMetrics = require("./fiscalMetrics");
  } catch (_) {
    return;
  }
  const contagem = fiscalMetrics.contarCStatNaJanela("999", CSTAT_999_RATE_WINDOW_MIN);
  const condicao = contagem >= CSTAT_999_RATE_MAX;

  if (condicao) {
    if (!estadoCStat999.alertado) {
      const mensagem = `Taxa cStat 999 elevada: ${contagem} ocorrência(s) em ${CSTAT_999_RATE_WINDOW_MIN} min (limite ${CSTAT_999_RATE_MAX})`;
      const dados = {
        cStat: "999",
        contagem,
        janelaMinutos: CSTAT_999_RATE_WINDOW_MIN,
        limite: CSTAT_999_RATE_MAX,
      };
      logCritico("CSTAT_999_ELEVADO", mensagem, dados);
      void enviarWebhook("CSTAT_999_ELEVADO", mensagem, dados);
    }
    estadoCStat999 = { alertado: true, contagem, desde: estadoCStat999.desde || Date.now() };
  } else {
    estadoCStat999 = { alertado: false, contagem };
  }
}

function verificarContingenciaOfflineIdade(snapshot) {
  if (!snapshot || snapshot.alertaIdade !== true) {
    estadoFilaSustentada.set("nfce_offline", { alertado: false });
    return;
  }
  const horas = Number(snapshot.maisAntigaHoras || 0);
  const limite = Number(snapshot.alertaIdadeHoras || 2);
  const qtd = (snapshot.estouradas && snapshot.estouradas.length) || 0;
  const anterior = estadoFilaSustentada.get("nfce_offline") || { alertado: false };
  if (anterior.alertado) return;
  const mensagem = `NFC-e off-line pendente há ${horas.toFixed(1)}h (limite ${limite}h, ${qtd} nota(s)) — risco fiscal se o sync não estiver rodando`;
  const dados = {
    nome: "nfce_offline",
    maisAntigaHoras: horas,
    limiteHoras: limite,
    pendentes: snapshot.pendentes,
    estouradas: qtd,
  };
  logCritico("CONTINGENCIA_OFFLINE_IDADE", mensagem, dados);
  void enviarWebhook("CONTINGENCIA_OFFLINE_IDADE", mensagem, dados);
  estadoFilaSustentada.set("nfce_offline", { alertado: true, desde: Date.now() });
}

function executarMonitoramento(deps = {}) {
  try {
    if (deps.filaFiscalMetricas) {
      verificarFilaPendenteSustentada("fila_fiscal", deps.filaFiscalMetricas);
    }
    if (deps.filaOfflineMetricas) {
      verificarFilaPendenteSustentada("vendas_offline", deps.filaOfflineMetricas);
    }
    if (deps.nfceOfflineMetricas) {
      verificarContingenciaOfflineIdade(deps.nfceOfflineMetricas);
    }
    verificarTaxaCStat999();
  } catch (err) {
    log.warn({ err: err.message }, "Monitoramento de alertas falhou");
  }
}

function iniciarMonitorPeriodico(obterDepsFn) {
  if (monitorTimer || process.env.NODE_ENV === "test") return;
  const tick = () => {
    try {
      const deps = typeof obterDepsFn === "function" ? obterDepsFn() : {};
      executarMonitoramento(deps);
    } catch (err) {
      log.warn({ err: err.message }, "Tick de monitoramento falhou");
    }
  };
  monitorTimer = setInterval(tick, ALERTA_MONITOR_INTERVAL_MS);
  tick();
}

function obterEstadoAlertas() {
  const filasSustentadas = {};
  for (const [nome, st] of estadoFilaSustentada.entries()) {
    filasSustentadas[nome] = { ...st };
  }
  let cStat999 = { ...estadoCStat999 };
  try {
    const fiscalMetrics = require("./fiscalMetrics");
    cStat999.contagem = fiscalMetrics.contarCStatNaJanela("999", CSTAT_999_RATE_WINDOW_MIN);
    cStat999.janelaMinutos = CSTAT_999_RATE_WINDOW_MIN;
    cStat999.limite = CSTAT_999_RATE_MAX;
    cStat999.ativo = cStat999.contagem >= CSTAT_999_RATE_MAX;
  } catch (_) {}
  return {
    filasSustentadas,
    cStat999,
    thresholds: obterConfigAlertas(),
  };
}

function obterConfigAlertas() {
  return {
    filaPendenteThreshold: FILA_PENDENTE_ALERTA_THRESHOLD,
    filaPendenteIdadeMin: FILA_PENDENTE_IDADE_MIN,
    cStat999WindowMin: CSTAT_999_RATE_WINDOW_MIN,
    cStat999RateMax: CSTAT_999_RATE_MAX,
    alertaIncertosMax: ALERTA_INCERTOS_MAX,
    monitorIntervalMs: ALERTA_MONITOR_INTERVAL_MS,
    webhookConfigurado: !!WEBHOOK_URL,
  };
}

function contarAlertasDispatchados() {
  return alertasDispatchados;
}

function iniciarRelatorioAutomatico(gerarRelatorioFn) {
  if (!RELATORIO_WEBHOOK_URL || relatorioTimer) return;
  const [hh, mm] = RELATORIO_HORARIO.split(":").map((n) => parseInt(n, 10));
  const tick = () => {
    const now = new Date();
    if (now.getHours() === hh && now.getMinutes() === mm) {
      const data = now.toISOString().slice(0, 10);
      try {
        const rel = gerarRelatorioFn(data);
        void enviarRelatorioWebhook(rel);
      } catch (err) {
        log.warn({ err: err.message }, "Relatório automático falhou");
      }
    }
  };
  relatorioTimer = setInterval(tick, 60000);
  tick();
}

function pararMonitorPeriodico() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

module.exports = {
  alertarFalhaPermanente,
  verificarIncertos,
  onAcbrStatusChange,
  verificarDiscoCritico,
  verificarFila,
  verificarFilaPendenteSustentada,
  verificarContingenciaOfflineIdade,
  verificarTaxaCStat999,
  executarMonitoramento,
  iniciarMonitorPeriodico,
  pararMonitorPeriodico,
  obterEstadoAlertas,
  obterConfigAlertas,
  contarAlertasDispatchados,
  enviarRelatorioWebhook,
  iniciarRelatorioAutomatico,
  ALERTA_INCERTOS_MAX,
};
