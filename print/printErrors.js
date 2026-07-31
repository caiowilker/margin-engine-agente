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
  // Hard drain / hang após envio: NÃO sugerir fallback (FFI pode ainda imprimir).
  // Pré-impressão (ConfigGravar/Ativar) pode vir embrulhada em timeout — fallback OK.
  if (
    err?.code === "PRINT_HARD_DRAIN" ||
    err?.code === "ACBR_POS_TIMEOUT" ||
    err?.code === "ACBR_POS_WORKER_KILLED" ||
    err?.code === "RAW_PRINT_TIMEOUT" ||
    err?.printTimedOut
  ) {
    out.retryable = false;
    const msgLow = msg.toLowerCase();
    const prePrintOnly =
      err?.fallbackNative === true ||
      ((/pos_configgravar|configgravarvalor|pos_ativar|pos_inicializar/i.test(msgLow) ||
        err?.acbrRet === -10) &&
        !/pos_imprimir|imprimir\b/i.test(msgLow));
    out.fallbackSuggested = !!prePrintOnly;
    return out;
  }
  // Worker morto / in-process bloqueado no Windows → native UMA vez neste job
  if (
    err?.code === "ACBR_POS_INPROCESS_BLOCKED" ||
    err?.fallbackNative === true
  ) {
    out.retryable = false;
    out.fallbackSuggested = true;
    return out;
  }
  // Erro ACBr após tentativa de envio — anti-dupla (sem segundo provider no mesmo job)
  if (err?.code === "ACBR_POS_ERROR" || err?.acbrRet != null) {
    out.retryable = false;
    // -10 em Ativar (antes de Imprimir): fallback native UMA vez é seguro
    const msgLow = msg.toLowerCase();
    const beforePrint =
      err?.acbrRet === -10 ||
      /pos_ativar|ativar|porta|n[aã]o definida|inicializar/i.test(msgLow);
    out.fallbackSuggested = beforePrint && !/pos_imprimir|imprimir/i.test(msgLow);
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
  if (err?.code === "PRINTER_PORTA_INDEFINIDA" || /porta da impressora n[aã]o configurada/i.test(msg)) {
    out.retryable = true;
    out.fallbackSuggested = true;
    return out;
  }
  return out;
}

module.exports = { classifyPrintError };
