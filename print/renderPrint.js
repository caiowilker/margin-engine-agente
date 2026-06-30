/**
 * Dispatcher de renderização térmica — cupom, DANFE simplificado, página teste.
 */
const { renderCupomTags } = require("./cupomAcbrTags");
const { renderDanfeTermicoTags } = require("./danfeTermico");
const { isDanfeTermico } = require("./segundaVia");
const { isNfeModelo55 } = require("../documentosFiscais");

function escolherRenderizador(payload) {
  if (payload?.danfeTermico || payload?.somenteDanfeTermico) return "danfe";
  if (isDanfeTermico(payload)) return "danfe";
  if (payload?.chaveNfe && isNfeModelo55(payload.chaveNfe) && payload?.layout === "danfe-termico") {
    return "danfe";
  }
  return "cupom";
}

function renderPayloadTags(payload) {
  const kind = escolherRenderizador(payload);
  if (kind === "danfe") return renderDanfeTermicoTags(payload);
  return renderCupomTags(payload);
}

module.exports = {
  escolherRenderizador,
  renderPayloadTags,
};
