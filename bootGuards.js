/**
 * Guards de boot — impede configuração de homolog/parity em produção fiscal.
 */
const log = require("./logger").child({ modulo: "boot_guards" });

function isTruthy(v) {
  return String(v || "")
    .trim()
    .toLowerCase() === "true";
}

function isProducaoFiscal() {
  let emissao = isTruthy(process.env.EMISSAO_FISCAL);
  try {
    const acbr = require("./acbr");
    if (typeof acbr.getEmissaoFiscalAtivo === "function") {
      emissao = acbr.getEmissaoFiscalAtivo();
    }
  } catch (_) {
    /* acbr opcional em testes isolados */
  }
  const amb =
    String(process.env.AMBIENTE_SEFAZ || "").toLowerCase() === "producao" ||
    process.env.AMBIENTE_SEFAZ === "1";
  return emissao && amb;
}

function assertProductionGuards() {
  if (!isProducaoFiscal()) return;

  const violations = [];
  if (isTruthy(process.env.ACBR_LIB_ALLOW_PARITY)) {
    violations.push("ACBR_LIB_ALLOW_PARITY=true");
  }
  if (isTruthy(process.env.PRINTER_ALLOW_PARITY)) {
    violations.push("PRINTER_ALLOW_PARITY=true");
  }
  if (isTruthy(process.env.FISCAL_ALLOW_LOCAL_INI)) {
    violations.push("FISCAL_ALLOW_LOCAL_INI=true");
  }
  if (String(process.env.ACBR_DRIVER || "lib").toLowerCase() === "monitor") {
    violations.push("ACBR_DRIVER=monitor (use lib em produção)");
  }

  if (violations.length > 0) {
    const msg =
      "Configuração inválida para emissão fiscal em PRODUÇÃO: " +
      violations.join(", ");
    log.error({ violations }, msg);
    throw new Error(msg);
  }
  log.info("Boot guards produção fiscal: OK");
}

module.exports = { assertProductionGuards, isProducaoFiscal };
