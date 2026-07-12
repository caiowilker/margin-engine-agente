// Montagem do payload POST /pdv/agente/heartbeat (telemetria + fila fiscal).
const { version: AGENT_VERSION } = require("./package.json");
const { lerFrontBuildId } = require("./frontVersion");

function resolverProviderId() {
  return process.env.ACBR_DRIVER === "lib"
    ? "agent-local-lib"
    : "agent-local-monitor";
}

function normalizarFilaFiscal(filaStatus = {}) {
  return {
    pendentes: filaStatus.pendentes ?? 0,
    incerto: filaStatus.incerto ?? 0,
    processando: filaStatus.processando ?? 0,
    recuperando: filaStatus.recuperando ?? 0,
    falhasTemporarias: filaStatus.falhasTemporarias ?? 0,
    falhas: filaStatus.falhas ?? 0,
    concluidos: filaStatus.concluidos ?? 0,
    pausada: filaStatus.pausada ? 1 : 0,
  };
}

function montarPayloadHeartbeat(filaStatus = {}, opts = {}) {
  const agentVersion = opts.agentVersion ?? AGENT_VERSION;
  const frontVersion = opts.frontVersion ?? lerFrontBuildId(opts.baseDir);
  const payload = {
    providerId: opts.providerId ?? resolverProviderId(),
    filaFiscal: normalizarFilaFiscal(filaStatus),
    agentVersion,
  };
  if (frontVersion) {
    payload.frontVersion = frontVersion;
  }
  return payload;
}

module.exports = {
  montarPayloadHeartbeat,
  normalizarFilaFiscal,
  resolverProviderId,
  AGENT_VERSION,
};
