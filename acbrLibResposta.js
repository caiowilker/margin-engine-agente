/**
 * Parser de respostas ACBrLib nativo (JSON TipoResposta=2 e INI legado).
 * Formato JSON: { "Envio": { "CStat": 100, "NFe62": { "chDFe": "..." } } }
 * Formato INI: [STATUS] CStat=107 / [ENVIO] CStat=100 (documentação ACBrLibNFe)
 */
const acbr = require("./acbr");

function pick(...vals) {
  for (const v of vals) {
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/** Bloco filho NFeNNN dentro de Envio (protocolo autorizado). */
function findNestedNfeBlock(envio) {
  if (!envio || typeof envio !== "object") return null;
  for (const key of Object.keys(envio)) {
    if (/^NFe\d+$/i.test(key) && envio[key] && typeof envio[key] === "object") {
      return envio[key];
    }
  }
  return null;
}

/** Extrai campos de resposta JSON da ACBrLib (TipoResposta=2). */
function parseJsonAcbrLib(bruto) {
  try {
    const j = JSON.parse(String(bruto || "").trim());
    if (!j || typeof j !== "object") return null;

    const envio = j.Envio || j.envio || null;
    const block =
      envio ||
      j.Status ||
      j.status ||
      j.Consulta ||
      j.consulta ||
      j.Cancelamento ||
      j.cancelamento ||
      j.Inutilizacao ||
      j.inutilizacao ||
      j.Evento ||
      j.evento ||
      null;
    if (!block) return null;

    const nested = envio ? findNestedNfeBlock(envio) : null;

    const cStatRaw = pick(
      nested?.cStat,
      nested?.CStat,
      block.CStat,
      block.cStat,
    );
    const cStat = cStatRaw != null ? String(cStatRaw) : null;

    return {
      cStat,
      xMotivo: pick(
        nested?.xMotivo,
        nested?.XMotivo,
        block.XMotivo,
        block.xMotivo,
        block.Msg,
        block.msg,
      ),
      chave: pick(
        nested?.chDFe,
        nested?.chNFe,
        block.chNFe,
        block.chDFe,
        block.Chave,
      ),
      protocolo: pick(
        nested?.nProt,
        nested?.NProt,
        block.NProt,
        block.nProt,
      ),
      tpAmb: pick(block.tpAmb, block.TpAmb, nested?.tpAmb),
      xml: pick(nested?.XML, nested?.xml, block.XML, block.xml),
    };
  } catch (_) {
    return null;
  }
}

function parseRespostaLib(resposta) {
  const bruto = String(resposta ?? "");
  const fromJson = parseJsonAcbrLib(bruto);
  if (fromJson?.cStat) {
    return { ...fromJson, raw: resposta, native: true };
  }

  const base = acbr.parseResposta(resposta);
  if (base.cStat) {
    return { ...base, native: true };
  }

  const cStat =
    fromJson?.cStat ||
    base.cStat ||
    bruto.match(/CStat\s*[=:]\s*(\d+)/i)?.[1] ||
    bruto.match(/cStat\s*[=:]\s*(\d+)/i)?.[1] ||
    null;
  const xMotivo =
    fromJson?.xMotivo ||
    base.xMotivo ||
    bruto.match(/XMotivo\s*[=:]\s*(.+)/i)?.[1]?.trim() ||
    bruto.match(/xMotivo\s*[=:]\s*(.+)/i)?.[1]?.trim() ||
    null;

  return {
    ...base,
    cStat,
    xMotivo,
    chave:
      fromJson?.chave ||
      base.chave ||
      bruto.match(/chDFe\s*[=:]\s*(\d{44})/i)?.[1] ||
      bruto.match(/chNFe\s*[=:]\s*(\d{44})/i)?.[1] ||
      null,
    protocolo: fromJson?.protocolo || base.protocolo,
    tpAmb: fromJson?.tpAmb || base.tpAmb,
    raw: resposta,
    native: true,
  };
}

module.exports = { parseRespostaLib, parseJsonAcbrLib };
