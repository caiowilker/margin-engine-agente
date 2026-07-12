/**
 * Versão do contrato HTTP entre o front (PWA) e o agente local.
 * Não confundir com a versão do pacote npm (`package.json`).
 *
 * Incrementar somente quando houver mudança breaking em payload ou endpoint
 * consumido pelo front no boot ou no fluxo de caixa. Ver docs/API_CONTRACT_VERSION.md.
 */
const API_CONTRACT_VERSION = 3;

module.exports = {
  API_CONTRACT_VERSION,
};
