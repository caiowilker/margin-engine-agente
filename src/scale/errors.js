"use strict";

/**
 * Catálogo SCALE_* — mensagens operador (PT), sem hex/stack.
 */

const SCALE_ERRORS = Object.freeze({
  SCALE_DISABLED: {
    http: 503,
    erro: "Balança desligada no agente.",
    acaoRecomendada: "PDV → Configurações → Impressão: habilite a balança, Salve e Teste.",
    recuperavel: true,
  },
  SCALE_NOT_CONFIGURED: {
    http: 400,
    erro: "Porta da balança não configurada.",
    acaoRecomendada: "Selecione a COM e salve.",
    recuperavel: true,
  },
  SCALE_PROTOCOL_UNSUPPORTED: {
    http: 400,
    erro: "Protocolo da balança não suportado.",
    acaoRecomendada: "Escolha Toledo, Filizola BP ou Urano 12.",
    recuperavel: true,
  },
  SCALE_PORT_BUSY: {
    http: 409,
    erro: "A porta da balança está em uso.",
    acaoRecomendada: "Feche outro programa ou reinicie o agente.",
    recuperavel: true,
  },
  SCALE_OPEN_FAILED: {
    http: 503,
    erro: "Não foi possível abrir a balança.",
    acaoRecomendada: "Confira cabo USB/COM. O Windows pode ter renumerado a porta — Atualizar e Testar.",
    recuperavel: true,
  },
  SCALE_TIMEOUT: {
    http: 504,
    erro: "A balança não respondeu a tempo.",
    acaoRecomendada: "Prix 3 ligada e protocolo Prt3.",
    recuperavel: true,
  },
  SCALE_UNSTABLE: {
    http: 409,
    erro: "Peso instável — aguarde parar.",
    acaoRecomendada: "Espere estabilizar.",
    recuperavel: true,
  },
  SCALE_INVALID_FRAME: {
    http: 502,
    erro: "Resposta da balança inválida.",
    acaoRecomendada: "Baud/protocolo ENQ_STX5.",
    recuperavel: true,
  },
  SCALE_ZERO_OR_NEGATIVE: {
    http: 422,
    erro: "Peso inválido na balança.",
    acaoRecomendada: "Zere e coloque o produto.",
    recuperavel: true,
  },
  SCALE_OVER_CAPACITY: {
    http: 422,
    erro: "Peso acima da capacidade.",
    acaoRecomendada: "Divida a pesagem.",
    recuperavel: true,
  },
  SCALE_USB_GONE: {
    http: 503,
    erro: "Balança desconectada.",
    acaoRecomendada: "Reconecte e Testar.",
    recuperavel: true,
  },
  SCALE_BUSY: {
    http: 409,
    erro: "Leitura já em andamento.",
    acaoRecomendada: "Aguarde.",
    recuperavel: true,
  },
  SCALE_SESSION_CLOSED: {
    http: 409,
    erro: "Pesagem cancelada.",
    acaoRecomendada: "Abra o produto por kg de novo.",
    recuperavel: true,
  },
  SCALE_LOCK_WAIT_TIMEOUT: {
    http: 503,
    erro: "Equipamento ocupado.",
    acaoRecomendada: "Aguarde o cupom e tente.",
    recuperavel: true,
  },
  SCALE_NATIVE_MISSING: {
    http: 500,
    erro: "Módulo serial indisponível.",
    acaoRecomendada: "Reinstale/Repare o Margin Engine.",
    recuperavel: false,
  },
  SCALE_AGENT_REQUIRED: {
    http: 503,
    erro: "Agente local necessário para pesar.",
    acaoRecomendada: "Abra o PDV pelo agente.",
    recuperavel: true,
  },
});

class ScaleError extends Error {
  /**
   * @param {string} codigo
   * @param {{ detail?: string, cause?: Error }} [opts]
   */
  constructor(codigo, opts = {}) {
    const entry = SCALE_ERRORS[codigo] || {
      http: 500,
      erro: "Erro na balança.",
      acaoRecomendada: "Tente novamente.",
      recuperavel: true,
    };
    super(entry.erro);
    this.name = "ScaleError";
    this.codigo = codigo;
    this.http = entry.http;
    this.acaoRecomendada = entry.acaoRecomendada;
    this.recuperavel = entry.recuperavel;
    this.detail = opts.detail || null;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      ok: false,
      erro: this.message,
      codigo: this.codigo,
      acaoRecomendada: this.acaoRecomendada,
      recuperavel: this.recuperavel,
    };
  }
}

function toScaleError(err) {
  if (err instanceof ScaleError) return err;
  if (err && err.code === "PHYSICAL_LOCK_WAIT_TIMEOUT") {
    return new ScaleError("SCALE_LOCK_WAIT_TIMEOUT", { cause: err });
  }
  const msg = String(err?.message || err || "");
  if (/Access denied|EACCES|EBUSY|in use/i.test(msg)) {
    return new ScaleError("SCALE_PORT_BUSY", { cause: err });
  }
  if (/ENOENT|cannot open|No such file|File not found/i.test(msg)) {
    return new ScaleError("SCALE_OPEN_FAILED", { cause: err });
  }
  if (/disconnect|gone|unplug|removed/i.test(msg)) {
    return new ScaleError("SCALE_USB_GONE", { cause: err });
  }
  return new ScaleError("SCALE_OPEN_FAILED", { detail: msg, cause: err });
}

function sendError(res, err) {
  const se = toScaleError(err);
  return res.status(se.http).json(se.toJSON());
}

module.exports = {
  SCALE_ERRORS,
  ScaleError,
  toScaleError,
  sendError,
};
