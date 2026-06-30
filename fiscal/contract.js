/**
 * Contrato do driver fiscal do agente local.
 * Espelha os exports de acbr.js — qualquer provider deve implementar esta superfície.
 *
 * @typedef {object} FiscalDriver
 * @property {() => Promise<boolean>} testar
 * @property {() => Promise<object>} statusServico
 * @property {(chave: string) => Promise<object>} consultarChave
 * @property {(payload: object) => Promise<object>} emitirNfce
 * @property {(payload: object) => Promise<object>} emitirNfe
 * @property {() => boolean} isNfeModelo55Habilitado
 * @property {(payload: object, numeracao?: object) => string} montarIniNfe
 * @property {(ini: string, modelo: string) => Promise<object>} criarEnviarIniModelo
 * @property {(xml: string, modelo: string) => Promise<object>} enviarNfeModelo
 * @property {(chave: string, motivo: string) => Promise<object>} cancelarNfce
 * @property {(body: object) => Promise<object>} inutilizarNfce
 * @property {(chave: string, xmlPath: string, modelo: string) => Promise<string>} gerarPdfFiscal
 * @property {(chave: string, xmlPath: string) => Promise<string>} gerarPdfDanfce
 * @property {(chave: string, xmlPath: string) => Promise<string>} gerarPdfDanfe
 * @property {(chave: string) => string|null} inferirModeloDaChave
 * @property {(chave: string, xmlPath?: string) => Promise<object>} imprimirDanfce
 * @property {(cmd: string, timeout?: number) => Promise<string>} enviarComando
 * @property {(cmd: string, timeout?: number) => Promise<string>} enviarNfe
 * @property {(cmds: string[]) => Promise<string>} enviarNfeComandos
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} withAcbrLock
 * @property {() => boolean} isAcbrBusy
 * @property {(valor: boolean|null) => void} setRuntimeEmissaoFiscal
 * @property {() => boolean} getRuntimeEmissaoFiscal
 * @property {(resposta: string) => object} parseResposta
 * @property {(payload: object, numeracao?: object) => string} montarIniNfce
 * @property {(empresa: object) => Promise<object>} enriquecerEmpresa
 * @property {(empresa: object) => void} validarEmpresaFiscal
 * @property {(watchdogDegraded?: boolean) => string} obterStatusMemoria
 * @property {(watchdogDegraded?: boolean) => object} obterStatusDetalhe
 * @property {(ok: boolean) => void} atualizarStatusMemoria
 * @property {boolean} EMISSAO_FISCAL
 */

/** Métodos obrigatórios para paridade com acbr.js (Fase 2 da migração ACBrLib). */
const REQUIRED_METHODS = [
  "testar",
  "statusServico",
  "consultarChave",
  "emitirNfce",
  "emitirNfe",
  "isNfeModelo55Habilitado",
  "cancelarNfce",
  "inutilizarNfce",
  "gerarPdfFiscal",
  "gerarPdfDanfce",
  "gerarPdfDanfe",
  "inferirModeloDaChave",
  "withAcbrLock",
  "isAcbrBusy",
  "setRuntimeEmissaoFiscal",
  "getRuntimeEmissaoFiscal",
  "parseResposta",
  "montarIniNfce",
  "montarIniNfe",
  "enviarEventoFiscal",
  "obterStatusMemoria",
  "obterStatusDetalhe",
];

/**
 * @param {object} driver
 * @param {string} providerName
 */
function assertFiscalDriverContract(driver, providerName) {
  const missing = REQUIRED_METHODS.filter(
    (m) => typeof driver[m] !== "function" && m !== "EMISSAO_FISCAL",
  );
  if (missing.length) {
    throw new Error(
      `Fiscal driver "${providerName}" incompleto — faltam: ${missing.join(", ")}`,
    );
  }
}

module.exports = {
  REQUIRED_METHODS,
  assertFiscalDriverContract,
};
