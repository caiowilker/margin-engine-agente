"use strict";

/**
 * Ponto de extensão dos adapters CT-e/MDF-e.
 *
 * O pacote base não entrega DLLs, schemas ou um executor ACBr de transporte.
 * Quando instalado, o adapter deve expor `preflight` e `enqueue` e reutilizar
 * o contexto recebido (fila persistente, callback e correlationId).
 */
function resolverAdapterTransporte() {
  try {
    // Instaladores com capacidade CT-e/MDF-e acrescentam este módulo. Não
    // declarar um fallback evita que comandos NFe sejam usados indevidamente.
    return require("./drivers/transporteFiscalAdapter");
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
}

function validarAdapter(adapter) {
  return (
    adapter &&
    typeof adapter.preflight === "function" &&
    typeof adapter.enqueue === "function"
  );
}

module.exports = {
  resolverAdapterTransporte,
  validarAdapter,
};
