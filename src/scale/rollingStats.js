"use strict";

const DEFAULT_WINDOW = 50;

/**
 * Janela rolante de latências/erros para /scale/status e /scale/diagnostico.
 */
function createRollingStats(windowSize = DEFAULT_WINDOW) {
  const max = Math.max(5, Number(windowSize) || DEFAULT_WINDOW);
  /** @type {number[]} */
  let latencies = [];
  let readsOk = 0;
  let readsFail = 0;
  let overlapSkips = 0;
  /** @type {string|null} */
  let lastCodigo = null;

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return Math.round(sorted[idx]);
  }

  function recordOk(latencyMs) {
    readsOk += 1;
    lastCodigo = null;
    const n = Number(latencyMs);
    if (Number.isFinite(n) && n >= 0) {
      latencies.push(Math.round(n));
      if (latencies.length > max) latencies = latencies.slice(-max);
    }
  }

  function recordFail(codigo) {
    readsFail += 1;
    if (codigo) lastCodigo = String(codigo);
  }

  function recordOverlapSkip() {
    overlapSkips += 1;
    lastCodigo = "SCALE_BUSY";
  }

  function snapshot() {
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      window: max,
      samples: latencies.length,
      readsOk,
      readsFail,
      overlapSkips,
      p50LatencyMs: percentile(sorted, 0.5),
      p95LatencyMs: percentile(sorted, 0.95),
      lastCodigo,
    };
  }

  function reset() {
    latencies = [];
    readsOk = 0;
    readsFail = 0;
    overlapSkips = 0;
    lastCodigo = null;
  }

  return {
    recordOk,
    recordFail,
    recordOverlapSkip,
    snapshot,
    reset,
  };
}

module.exports = { createRollingStats, DEFAULT_WINDOW };
