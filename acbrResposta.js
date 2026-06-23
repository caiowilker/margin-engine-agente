// Normalização de respostas TCP do ACBr Monitor (string | string[])

function coalescerRespostaAcbr(resposta) {
  if (resposta == null) return "";
  if (Array.isArray(resposta)) {
    return resposta.map((r) => String(r ?? "")).filter(Boolean).join("\n");
  }
  return String(resposta);
}

function extrairProtocoloBruto(bruto) {
  const t = coalescerRespostaAcbr(bruto);
  return (
    t.match(/\bnProt[=:\s]+(\d{10,})/i)?.[1] ||
    t.match(/\bProtocolo[=:\s]+(\d{10,})/i)?.[1] ||
    t.match(/\bNumeroProtocolo[=:\s]+(\d{10,})/i)?.[1] ||
    t.match(/<nProt>(\d+)<\/nProt>/i)?.[1] ||
    null
  );
}

/** cStat de sucesso de lote (não significa rejeição da nota). */
const CSTAT_LOTE_OK = new Set(["103", "104"]);

/** Consulta: chave ainda não indexada — não confundir com rejeição da emissão atual. */
const CSTAT_CONSULTA_NAO_LOCALIZADA = new Set(["217", "137"]);

function deveIgnorarCStatConsultaPosEmissao(cStatEmissao, cStatConsulta) {
  if (!CSTAT_LOTE_OK.has(String(cStatEmissao || ""))) return false;
  return CSTAT_CONSULTA_NAO_LOCALIZADA.has(String(cStatConsulta || ""));
}

function resolverCStatFinal({ todosCStat, prot, get }) {
  if (prot.cStat === "100" || prot.cStat === "150") return prot.cStat;

  const authLista = todosCStat.find((s) => s === "100" || s === "150");
  if (authLista) return authLista;

  if (prot.cStat && !CSTAT_LOTE_OK.has(prot.cStat)) return prot.cStat;

  const rejeicao = todosCStat.find((s) => {
    if (s === "100" || s === "150" || CSTAT_LOTE_OK.has(s)) return false;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 200;
  });
  if (rejeicao) return rejeicao;

  return (
    get("cStat") ||
    get("CStat") ||
    prot.cStat ||
    todosCStat.find((s) => CSTAT_LOTE_OK.has(s)) ||
    todosCStat[todosCStat.length - 1] ||
    null
  );
}

/** Somente cStat 100/150 (infProt) significam nota autorizada na SEFAZ. */
function isCStatAutorizado(cStat) {
  const cs = String(cStat || "");
  return cs === "100" || cs === "150";
}

module.exports = {
  coalescerRespostaAcbr,
  resolverCStatFinal,
  isCStatAutorizado,
  extrairProtocoloBruto,
  CSTAT_LOTE_OK,
  CSTAT_CONSULTA_NAO_LOCALIZADA,
  deveIgnorarCStatConsultaPosEmissao,
};
