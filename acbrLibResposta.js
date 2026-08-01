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
    const dist =
      j.DistribuicaoDFe ||
      j.distribuicaoDFe ||
      j.Distribuicao ||
      j.distribuicao ||
      null;
    const block =
      envio ||
      dist ||
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
      ultNSU: pick(block.ultNSU, block.UltNSU, block.ultNsu),
      maxNSU: pick(block.maxNSU, block.MaxNSU, block.maxNsu),
      /** Bloco DistDFe bruto (JSON TipoResposta=2). */
      distribuicaoDFe: dist || null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Extrai XMLs / resNFe dos blocos ResDFe* (INI ou JSON ACBrLib DistDFe).
 */
function extrairDocsDistribuicaoDFe(resposta) {
  const xmls = [];
  const resumos = [];
  const bruto = String(resposta || "");

  try {
    const j = JSON.parse(bruto.trim());
    if (j && typeof j === "object") {
      const walk = (obj) => {
        if (!obj || typeof obj !== "object") return;
        for (const [key, val] of Object.entries(obj)) {
          if (/^ResDFe\d+$/i.test(key) && val && typeof val === "object") {
            const xml = pick(val.XML, val.xml, val.Arquivo, val.arquivo);
            const xmlStr = xml != null ? String(xml) : "";
            if (/<nfeProc[\s>]/i.test(xmlStr) || /<NFe[\s>]/i.test(xmlStr)) {
              xmls.push(xmlStr);
            } else if (/<resNFe[\s>]/i.test(xmlStr)) {
              resumos.push(xmlStr);
            } else {
              const ch = pick(val.chDFe, val.chNFe, val.Chave, val.chave);
              if (ch && String(ch).replace(/\D/g, "").length === 44) {
                const cnpj = pick(val.CNPJCPF, val.CNPJ, val.cnpj) || "";
                const xNome = pick(val.xNome, val.XNome, val.EmixNome) || "";
                const vNF = pick(val.vNF, val.VNF) || "";
                resumos.push(
                  `<resNFe><chNFe>${String(ch).replace(/\D/g, "")}</chNFe>` +
                    (cnpj ? `<CNPJ>${cnpj}</CNPJ>` : "") +
                    (xNome ? `<xNome>${xNome}</xNome>` : "") +
                    (vNF ? `<vNF>${vNF}</vNF>` : "") +
                    `</resNFe>`,
                );
              }
            }
          } else if (val && typeof val === "object") {
            walk(val);
          }
        }
      };
      walk(j);
    }
  } catch (_) {
    /* INI / texto */
  }

  return { xmls, resumos };
}

/**
 * Extrai cStat/xMotivo de retConsStatServ (arquivo *-sta.xml salvo com SalvarWS=1).
 * ACBrLib 1.5.x às vezes devolve JSON Status com CStat=0 vazio mesmo com SEFAZ 107 no XML.
 */
function parseRetConsStatServXml(xml) {
  const s = String(xml || "");
  if (!/<retConsStatServ[\s>]/i.test(s)) return null;
  const cStat = s.match(/<cStat>\s*(\d+)\s*<\/cStat>/i)?.[1] || null;
  if (cStat == null || String(cStat).trim() === "") return null;
  return {
    cStat: String(cStat),
    xMotivo: s.match(/<xMotivo>\s*([^<]*)\s*<\/xMotivo>/i)?.[1]?.trim() || null,
    tpAmb: s.match(/<tpAmb>\s*(\d+)\s*<\/tpAmb>/i)?.[1] || null,
    raw: s,
    native: true,
    source: "retConsStatServ_xml",
  };
}

/** JSON Status com CStat 0 e sem motivo = serialização vazia da Lib (não é rejeição SEFAZ). */
function isHollowStatusJson(parsed) {
  if (!parsed) return true;
  const c = String(parsed.cStat ?? "").trim();
  const motivo = String(parsed.xMotivo || "").trim();
  if (c === "" || c === "0") {
    return !motivo || /^[\s{}\[\]"']*$/.test(motivo) || /"CStat"\s*:\s*0/i.test(motivo);
  }
  return false;
}

function parseRespostaLib(resposta) {
  const rawObject =
    resposta && typeof resposta === "object" && !Array.isArray(resposta)
      ? resposta
      : null;
  const bruto =
    rawObject?.raw != null && String(rawObject.raw).trim() !== ""
      ? String(rawObject.raw)
      : rawObject
        ? JSON.stringify(rawObject)
        : String(resposta ?? "");
  const fromXmlInline = parseRetConsStatServXml(bruto);
  if (fromXmlInline) {
    return fromXmlInline;
  }
  const fromJson = parseJsonAcbrLib(bruto);
  if (
    fromJson &&
    fromJson.cStat != null &&
    String(fromJson.cStat).trim() !== "" &&
    !isHollowStatusJson(fromJson)
  ) {
    return { ...fromJson, raw: bruto, native: true };
  }

  const base = acbr.parseResposta(bruto);
  if (base.cStat != null && String(base.cStat).trim() !== "") {
    return {
      ...base,
      ultNSU: fromJson?.ultNSU || null,
      maxNSU: fromJson?.maxNSU || null,
      native: true,
    };
  }

  const cStat =
    fromJson?.cStat ||
    base.cStat ||
    (rawObject?.cStat != null ? String(rawObject.cStat) : null) ||
    bruto.match(/CStat\s*[=:]\s*(\d+)/i)?.[1] ||
    bruto.match(/cStat\s*[=:]\s*(\d+)/i)?.[1] ||
    bruto.match(/"CStat"\s*:\s*"?(\d+)"?/i)?.[1] ||
    bruto.match(/"cStat"\s*:\s*"?(\d+)"?/i)?.[1] ||
    null;
  const xMotivo =
    fromJson?.xMotivo ||
    base.xMotivo ||
    rawObject?.xMotivo ||
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
    ultNSU: fromJson?.ultNSU || null,
    maxNSU: fromJson?.maxNSU || null,
    raw: bruto,
    native: true,
  };
}

module.exports = {
  parseRespostaLib,
  parseJsonAcbrLib,
  parseRetConsStatServXml,
  isHollowStatusJson,
  extrairDocsDistribuicaoDFe,
};
