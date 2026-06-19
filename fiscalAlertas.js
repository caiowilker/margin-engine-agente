// Alertas push via webhook — fire-and-forget, nunca bloqueia fluxo fiscal
const auditLog = require("./auditLog");
const log = require("./logger").child({ modulo: "fiscal_alertas" });

const WEBHOOK_URL = process.env.WEBHOOK_ALERTAS_URL || "";
const ALERTA_INCERTOS_MAX = parseInt(process.env.ALERTA_INCERTOS_MAX || "5", 10);
const RELATORIO_WEBHOOK_URL = process.env.RELATORIO_WEBHOOK_URL || "";
const RELATORIO_HORARIO = process.env.RELATORIO_HORARIO || "23:59";

let ultimoAcbrStatus = null;
let ultimoDiscoCritico = false;
let alertasDispatchados = 0;
let relatorioTimer = null;

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

module.exports = {
  alertarFalhaPermanente,
  verificarIncertos,
  onAcbrStatusChange,
  verificarDiscoCritico,
  contarAlertasDispatchados,
  enviarRelatorioWebhook,
  iniciarRelatorioAutomatico,
  ALERTA_INCERTOS_MAX,
};
