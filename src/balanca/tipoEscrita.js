"use strict";

/**
 * Política de escrita por arquivo — alinhada ao backend BalancaTipoEscrita.
 * SNAPSHOT = overwrite livre; INCREMENTAL = exige confirmação/timeout.
 */
function tipoEscritaDeNome(nome) {
  if (!nome || typeof nome !== "string") return "SNAPSHOT";
  const up = nome.trim().toUpperCase();
  if (up.startsWith("PRECOMGV") || up.startsWith("EXCLITEM")) return "INCREMENTAL";
  return "SNAPSHOT";
}

/**
 * Resolve modoSombra: claim do lote (backend) > config local.
 * @param {object} lote
 * @param {object} cfg
 */
function resolverModoSombra(lote, cfg) {
  if (lote && typeof lote.modoSombra === "boolean") return lote.modoSombra;
  return cfg && cfg.modoSombra === true;
}

/**
 * Enum de status UI — mesmo contrato do backend BalancaEntregaStatusUi.
 */
const STATUS_UI = Object.freeze({
  PENDENTE: "PENDENTE",
  ENVIANDO: "ENVIANDO",
  AGUARDANDO_CONFIRMACAO: "AGUARDANDO_CONFIRMACAO",
  CONFIRMADO: "CONFIRMADO",
  FALHOU: "FALHOU",
});

/** Mapeia status interno do agente (legado) → STATUS_UI. */
function statusUiDeAck(status) {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "ENTREGUE":
    case "ENVIANDO":
      return STATUS_UI.AGUARDANDO_CONFIRMACAO;
    case "IMPORTADO":
    case "CONFIRMADO":
    case "DIAGNOSTICO_OK":
      return STATUS_UI.CONFIRMADO;
    case "ENTREGUE_SEM_CONFIRMACAO":
    case "AGUARDANDO_CONFIRMACAO":
      return STATUS_UI.AGUARDANDO_CONFIRMACAO;
    case "TIMEOUT_IMPORTACAO":
    case "PASTA_INACESSIVEL":
    case "PASTA_OCUPADA":
    case "ERRO":
    case "DIAGNOSTICO_FALHA":
    case "FALHOU":
      return STATUS_UI.FALHOU;
    case "PENDENTE":
      return STATUS_UI.PENDENTE;
    default:
      return STATUS_UI.FALHOU;
  }
}

module.exports = {
  tipoEscritaDeNome,
  resolverModoSombra,
  STATUS_UI,
  statusUiDeAck,
};
