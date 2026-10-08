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

const fs = require("fs");
const zlib = require("zlib");

const MAX_ARQUIVO_DFE_BYTES = 5 * 1024 * 1024;
const RE_SECAO_EVENTO = /^(?:ResEve|ProEve|InfEve|ResEvento|ProcEvento)\d+$/i;
const RE_SECAO_DOC = /^[A-Za-z]+\d+$/;

function campo(obj, ...nomes) {
  if (!obj || typeof obj !== "object") return null;
  const mapa = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of nomes) {
    const k = mapa.get(n.toLowerCase());
    if (k != null) {
      const v = obj[k];
      if (v != null && typeof v !== "object" && String(v).trim() !== "") return String(v);
    }
  }
  return null;
}

function escaparXml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** docZip em base64 (gzip) → XML. Retorna null se não for gzip válido. */
function descompactarDocZip(valor) {
  const s = String(valor || "").trim();
  if (!/^H4sI[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  try {
    return zlib.gunzipSync(Buffer.from(s.replace(/\s+/g, ""), "base64")).toString("utf8");
  } catch (_) {
    return null;
  }
}

/** Arquivo pode ser o XML inline ou o caminho onde a ACBrLib salvou o documento. */
function lerArquivoDfe(valor) {
  const s = String(valor || "").trim();
  if (!s) return null;
  if (s.startsWith("<")) return s;
  try {
    const st = fs.statSync(s);
    if (st.isFile() && st.size > 0 && st.size <= MAX_ARQUIVO_DFE_BYTES) {
      return fs.readFileSync(s, "utf8");
    }
  } catch (_) {
    /* não é caminho legível */
  }
  return null;
}

function conteudoDoBloco(bloco) {
  const xml = campo(bloco, "XML", "xmlDoc", "Conteudo");
  if (xml && xml.trim().startsWith("<")) return xml;
  const zip = campo(bloco, "docZip", "DocZip", "XML", "Conteudo");
  const descompactado = zip ? descompactarDocZip(zip) : null;
  if (descompactado) return descompactado;
  return lerArquivoDfe(campo(bloco, "Arquivo", "arquivo", "Path", "CaminhoArquivo"));
}

/**
 * Classifica um bloco (seção INI ou objeto JSON) pelo conteúdo, não pelo nome da seção:
 * nfeProc/NFe → XML completo; resNFe → resumo; resEvento/procEventoNFe → evento.
 * Sem XML, usa schema e chave para montar um resumo mínimo.
 */
function classificarBlocoDfe(nomeSecao, bloco, out) {
  const conteudo = conteudoDoBloco(bloco);
  if (conteudo) {
    if (/<nfeProc[\s>]/i.test(conteudo) || /<NFe[\s>]/i.test(conteudo)) {
      out.xmls.push(conteudo);
      return;
    }
    if (/<resNFe[\s>]/i.test(conteudo)) {
      out.resumos.push(conteudo);
      return;
    }
    if (/<(?:resEvento|procEventoNFe|evento)[\s>]/i.test(conteudo)) {
      out.eventos += 1;
      return;
    }
  }
  const schema = (campo(bloco, "schema", "Schema") || "").toLowerCase();
  if (RE_SECAO_EVENTO.test(nomeSecao) || /evento/.test(schema)) {
    out.eventos += 1;
    return;
  }
  const ch = (campo(bloco, "chDFe", "chNFe", "Chave", "chave") || "").replace(/\D/g, "");
  if (ch.length === 44) {
    const cnpj = (campo(bloco, "CNPJCPF", "CNPJ", "CPF") || "").replace(/\D/g, "");
    const xNome = campo(bloco, "xNome", "EmixNome") || "";
    const vNF = campo(bloco, "vNF") || "";
    const dhEmi = campo(bloco, "dhEmi", "dEmi") || "";
    const tagDoc = cnpj.length === 11 ? "CPF" : "CNPJ";
    out.resumos.push(
      `<resNFe><chNFe>${ch}</chNFe>` +
        (cnpj ? `<${tagDoc}>${cnpj}</${tagDoc}>` : "") +
        (xNome ? `<xNome>${escaparXml(xNome)}</xNome>` : "") +
        (dhEmi ? `<dhEmi>${escaparXml(dhEmi)}</dhEmi>` : "") +
        (vNF ? `<vNF>${escaparXml(vNF)}</vNF>` : "") +
        `</resNFe>`,
    );
    return;
  }
  out.naoClassificados.push(nomeSecao);
}

/** Seções [Nome] chave=valor da resposta INI da ACBrLib/Monitor. */
function secoesIni(bruto) {
  const secoes = [];
  let atual = null;
  for (const linha of String(bruto).split(/\r?\n/)) {
    const cab = linha.match(/^\s*\[([^\]]+)\]\s*$/);
    if (cab) {
      atual = { nome: cab[1].trim(), campos: {} };
      secoes.push(atual);
      continue;
    }
    if (!atual) continue;
    const i = linha.indexOf("=");
    if (i > 0) atual.campos[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
  }
  return secoes;
}

/**
 * Extrai XMLs completos, resumos e eventos de uma página DistDFe (JSON TipoResposta=2 ou INI).
 * `naoClassificados` lista seções com documento que não deu para reconhecer (diagnóstico).
 */
function extrairDocsDistribuicaoDFe(resposta) {
  const out = { xmls: [], resumos: [], eventos: 0, naoClassificados: [], secoes: [] };
  const bruto = String(resposta || "");
  const texto = bruto.trim();

  let json = null;
  if (texto.startsWith("{") || texto.startsWith("[")) {
    try {
      json = JSON.parse(texto);
    } catch (_) {
      json = null;
    }
  }

  if (json && typeof json === "object") {
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const [key, val] of Object.entries(obj)) {
        if (!val || typeof val !== "object") continue;
        if (RE_SECAO_DOC.test(key) && !Array.isArray(val)) {
          out.secoes.push(key);
          classificarBlocoDfe(key, val, out);
        } else {
          walk(val);
        }
      }
    };
    walk(json);
  } else {
    for (const sec of secoesIni(bruto)) {
      if (!RE_SECAO_DOC.test(sec.nome)) continue;
      out.secoes.push(sec.nome);
      classificarBlocoDfe(sec.nome, sec.campos, out);
    }
  }

  return out;
}

/**
 * Conta eventos (resEvento/procEventoNFe) de uma página DistDFe — XML, seções INI
 * [ResEve001]/[ProEve001]/[InfEve001] ou chaves JSON equivalentes. Página só com
 * eventos é conteúdo legítimo (cStat 138) e o NSU deve avançar.
 */
function contarEventosDistribuicaoDFe(resposta) {
  const bruto = String(resposta || "");
  const xml = (bruto.match(/<(?:resEvento|procEventoNFe)[\s>]/gi) || []).length;
  const ini = (bruto.match(/^\s*\[(?:ResEve|ProEve|InfEve)\d+\]/gim) || []).length;
  const json = (bruto.match(/"(?:ResEve|ProEve|InfEve)\d+"\s*:/gi) || []).length;
  return Math.max(xml, ini, json);
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
  contarEventosDistribuicaoDFe,
};
