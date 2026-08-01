/**
 * Empacota exports de acbr.js preservando getters vivos (ex.: EMISSAO_FISCAL).
 *
 * Object.assign({}, acbr) avalia getters no momento da cópia e congela o valor —
 * após setRuntimeEmissaoFiscal() o driver continuaria com o snapshot do boot.
 */
const acbr = require("../acbr");

/**
 * @param {Record<string, unknown>} overrides
 * @returns {object}
 */
function wrapAcbrExports(overrides = {}) {
  const base = Object.assign({}, acbr, overrides);
  // Reinstala getter vivo DEPOIS do assign (assign teria congelado o boolean).
  Object.defineProperty(base, "EMISSAO_FISCAL", {
    enumerable: true,
    configurable: true,
    get() {
      return acbr.getRuntimeEmissaoFiscal
        ? acbr.getRuntimeEmissaoFiscal()
        : acbr.EMISSAO_FISCAL;
    },
  });
  // Garante que set/get runtime no driver apontam para o mesmo SSOT de acbr.js
  if (typeof acbr.setRuntimeEmissaoFiscal === "function") {
    base.setRuntimeEmissaoFiscal = (v) => acbr.setRuntimeEmissaoFiscal(v);
  }
  if (typeof acbr.getRuntimeEmissaoFiscal === "function") {
    base.getRuntimeEmissaoFiscal = () => acbr.getRuntimeEmissaoFiscal();
  }
  return base;
}

module.exports = { wrapAcbrExports };
