"use strict";

/**
 * Contrato HTTP de impressão: 202 + fila=true é ENFILEIRADO (ainda não saiu papel);
 * só 200 sem fila é IMPRESSO. Quem consome nunca deve tratar fila como sucesso final.
 */
const STATUS_ENTREGA = Object.freeze({
  ENFILEIRADO: "ENFILEIRADO",
  IMPRESSO: "IMPRESSO",
});

const MENSAGEM_FILA = "Impressão na fila — será reenviada automaticamente.";

function foiEnfileirado(resultado) {
  return !!(resultado && (resultado.queued || resultado.async));
}

function corpoEnfileirado(resultado, extra = {}) {
  return {
    ok: true,
    fila: true,
    status: STATUS_ENTREGA.ENFILEIRADO,
    impresso: false,
    mensagem: (resultado && resultado.message) || MENSAGEM_FILA,
    jobId: resultado ? resultado.jobId : undefined,
    ...extra,
  };
}

function corpoImpresso(extra = {}) {
  return { ok: true, ...extra, fila: false, status: STATUS_ENTREGA.IMPRESSO, impresso: true };
}

/** Responde 202 (ENFILEIRADO) ou 200 (IMPRESSO) conforme o resultado do serviço de impressão. */
function responderImpressao(res, resultado, { extraFila = {}, extraImpresso = {} } = {}) {
  if (foiEnfileirado(resultado)) {
    return res.status(202).json(corpoEnfileirado(resultado, extraFila));
  }
  return res.json(corpoImpresso(extraImpresso));
}

module.exports = {
  STATUS_ENTREGA,
  MENSAGEM_FILA,
  foiEnfileirado,
  corpoEnfileirado,
  corpoImpresso,
  responderImpressao,
};
