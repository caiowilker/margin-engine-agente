// Payload de callback NFS-e → backend (POST /pdv/nfse/rps/{numero}/fiscal/resultado)

function derivarStatusFiscal(cStat) {
  const cs = String(cStat ?? "").trim();
  if (cs === "100" || cs === "150") return "AUTORIZADA";
  if (cs === "103" || cs === "104") return "PENDENTE_SEFAZ";
  return "REJEITADA";
}

function montarCallbackBackendNfse(resultado, correlationId, xmlContent) {
  return {
    correlationId,
    chaveNfe: resultado.chave || resultado.chaveNfse || resultado.chaveNfe,
    numeroNfe: resultado.numero || resultado.numeroNfse || resultado.numeroNfe,
    chaveNfse: resultado.chave || resultado.chaveNfse,
    numeroNfse: resultado.numero || resultado.numeroNfse,
    serieRps: resultado.serie || resultado.serieRps,
    protocolo: resultado.protocolo,
    cStat: resultado.cStat || null,
    xMotivo: resultado.xMotivo || null,
    statusFiscal: derivarStatusFiscal(resultado.cStat),
    xmlContent: xmlContent || resultado.xml || null,
    modeloDocumento: "99",
    recuperado: !!resultado.recuperado,
  };
}

module.exports = {
  montarCallbackBackendNfse,
  derivarStatusFiscal,
};
