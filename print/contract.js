/**
 * Contrato PrinterProvider — espelha API pública de impressora.js.
 * Nenhum módulo externo deve importar drivers diretamente.
 *
 * @typedef {object} PrinterProvider
 * @property {() => string} getProviderName
 * @property {() => object} getDriverInfo
 * @property {(force?: boolean) => Promise<boolean>} testar
 * @property {(force?: boolean) => Promise<object>} getInfo
 * @property {() => object} listar
 * @property {() => Promise<object>} detectar
 * @property {(payload: object) => Promise<object>} imprimirCupom
 * @property {(payload: object) => Promise<object>} imprimirAbertura
 * @property {(payload: object) => Promise<object>} imprimirFechamento
 * @property {(payload: object) => Promise<object>} imprimirMovimentoCaixa
 * @property {() => Promise<object>} abrirGaveta
 * @property {(tags: string) => Promise<object>} [imprimirTags]
 */

const REQUIRED_METHODS = [
  "getProviderName",
  "getDriverInfo",
  "testar",
  "getInfo",
  "listar",
  "detectar",
  "imprimirCupom",
  "imprimirSegundaVia",
  "imprimirAbertura",
  "imprimirFechamento",
  "imprimirMovimentoCaixa",
  "abrirGaveta",
];

function assertPrinterProviderContract(provider, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof provider[m] !== "function");
  if (missing.length) {
    throw new Error(`PrinterProvider "${name}" incompleto — faltam: ${missing.join(", ")}`);
  }
}

module.exports = {
  REQUIRED_METHODS,
  assertPrinterProviderContract,
};
