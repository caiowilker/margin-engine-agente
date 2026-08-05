/**
 * Métricas do último job de impressão — painel PDV / diagnóstico.
 */
let lastPrint = {
  at: null,
  durationMs: null,
  provider: null,
  op: null,
  logoIncluded: null,
  logoSkipReason: null,
  ok: null,
};

function recordPrintResult( partial = {}) {
  lastPrint = {
    at: Date.now(),
    durationMs:
      partial.durationMs != null ? Number(partial.durationMs) : lastPrint.durationMs,
    provider: partial.provider != null ? String(partial.provider) : lastPrint.provider,
    op: partial.op != null ? String(partial.op) : lastPrint.op,
    logoIncluded:
      partial.logoIncluded != null ? !!partial.logoIncluded : lastPrint.logoIncluded,
    logoSkipReason:
      partial.logoSkipReason !== undefined
        ? partial.logoSkipReason
        : lastPrint.logoSkipReason,
    ok: partial.ok != null ? !!partial.ok : lastPrint.ok,
  };
  return { ...lastPrint };
}

function getLastPrintMetrics() {
  return { ...lastPrint };
}

module.exports = {
  recordPrintResult,
  getLastPrintMetrics,
};
