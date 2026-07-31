/**
 * Classificação de erros de impressão — fallback e observabilidade.
 */
const RETRYABLE = /timeout|ocupad|busy|offline|desconect|unavailable|econnrefused|econnreset|sem papel|tampa|buffer/i;
const PERMANENT = /payload|obrigat|invalid|qr code|nfc-e autorizada|n[aã]o [eé] t[eé]rmica|PRINTER_NOT_THERMAL|jato\/laser/i;

function classifyPrintError(err) {
  const msg = String(err?.message || err || "");
  const out = { message: msg, retryable: false, permanente: false, fallbackSuggested: true };
  if (err?.code === "PRINTER_NOT_THERMAL" || err?.permanente) {
    out.permanente = true;
    out.retryable = false;
    out.fallbackSuggested = false;
    return out;
  }
  if (PERMANENT.test(msg)) {
    out.permanente = true;
    out.fallbackSuggested = false;
    return out;
  }
  // Hard drain / hang: fallback native UMA vez no executor — NÃO martelar fila
  // (FFI pode ainda estar viva; retry reabre sessão → dupla impressão / deadlock).
  if (
    err?.code === "PRINT_HARD_DRAIN" ||
    err?.code === "ACBR_POS_TIMEOUT" ||
    err?.code === "ACBR_POS_WORKER_KILLED" ||
    err?.printTimedOut
  ) {
    out.retryable = false;
    out.fallbackSuggested = true;
    return out;
  }
  // Bug de binding koffi (arity) — fallback native uma vez; não reprocessar em loop
  if (/expected \d+ arguments, got \d+/i.test(msg) || err?.code === "ACBR_POS_FN_MISSING") {
    out.retryable = false;
    out.fallbackSuggested = true;
    return out;
  }
  if (RETRYABLE.test(msg)) {
    out.retryable = true;
    return out;
  }
  // koffi / ffi ausente no instalador → fallback ESC/POS nativo
  if (/cannot find module ['"]koffi['"]|cannot find module ['"]ffi-napi['"]|cannot find module ['"]ref-napi['"]/i.test(msg)) {
    out.fallbackSuggested = true;
    out.retryable = false;
    return out;
  }
  // Bug de layout (ex.: TDZ COLS) — tentar outro provider se houver
  if (/COLS is not defined|before initialization/i.test(msg)) {
    out.fallbackSuggested = true;
    out.retryable = false;
    return out;
  }
  if (/biblioteca|dll|pos_inicializar|pos_ativar|unconfigured/i.test(msg)) {
    out.fallbackSuggested = true;
    out.permanente = false;
    return out;
  }
  if (err?.acbrRet === -10 || /\(-10\)/.test(msg)) {
    // Ativar -10 neste hardware: fallback native uma vez; não martelar fila.
    out.retryable = false;
    out.fallbackSuggested = true;
    return out;
  }
  if (err?.code === "PRINTER_PORTA_INDEFINIDA" || /porta da impressora n[aã]o configurada/i.test(msg)) {
    out.retryable = true;
    out.fallbackSuggested = true;
    return out;
  }
  return out;
}

module.exports = { classifyPrintError };
