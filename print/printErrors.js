/**
 * Classificação de erros de impressão — fallback e observabilidade.
 */
const RETRYABLE = /timeout|ocupad|busy|offline|desconect|unavailable|econnrefused|econnreset|sem papel|tampa|buffer/i;
const PERMANENT = /payload|obrigat|invalid|qr code|nfc-e autorizada/i;

function classifyPrintError(err) {
  const msg = String(err?.message || err || "");
  const out = { message: msg, retryable: false, permanente: false, fallbackSuggested: true };
  if (PERMANENT.test(msg)) {
    out.permanente = true;
    out.fallbackSuggested = false;
    return out;
  }
  if (RETRYABLE.test(msg)) {
    out.retryable = true;
    return out;
  }
  if (/biblioteca|dll|pos_inicializar|pos_ativar|unconfigured/i.test(msg)) {
    out.fallbackSuggested = true;
    out.permanente = false;
    return out;
  }
  return out;
}

module.exports = { classifyPrintError };
