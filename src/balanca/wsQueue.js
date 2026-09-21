/**
 * Fila estritamente serial por MGV (baseUrl): nunca mutações paralelas.
 * IniciaImportacao cancela importação anterior — uma por vez.
 */
"use strict";

const queues = new Map();

function chave(mgvId) {
  return String(mgvId || "default");
}

/**
 * Enfileira uma função async; garante exclusão mútua por mgvId.
 */
function enfileirarSerial(mgvId, fn) {
  const k = chave(mgvId);
  const prev = queues.get(k) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => fn());
  queues.set(
    k,
    next.finally(() => {
      if (queues.get(k) === next) queues.delete(k);
    }),
  );
  return next;
}

function limparFilas() {
  queues.clear();
}

module.exports = { enfileirarSerial, limparFilas };
