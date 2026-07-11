// ACBr Monitor — emissão NFS-e (ABRASF 2.04) via documentIni do backend

const fs = require("fs");
const path = require("path");
const acbr = require("../../acbr");
const { PATHS } = require("../../marginPaths");
const { validarPayloadNfse } = require("./nfseValidate");
const fiscalEmissionLock = require("../fiscalEmissionLock");

const ACBR_TIMEOUT_EMISSAO = parseInt(process.env.ACBR_TIMEOUT_EMISSAO || "120000", 10);

function qAcbr(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

function parseRespostaNfse(resposta) {
  const base = acbr.parseResposta(resposta);
  const bruto = String(resposta || "");
  const numeroNfse =
    bruto.match(/NumeroNFSe\s*[=:]\s*(\S+)/i)?.[1] ||
    bruto.match(/Numero\s*[=:]\s*(\d+)/i)?.[1] ||
    base.numero;
  const chaveNfse =
    bruto.match(/ChaveNFSe\s*[=:]\s*(\S+)/i)?.[1] ||
    bruto.match(/CodigoVerificacao\s*[=:]\s*(\S+)/i)?.[1] ||
    base.chave;
  const serie =
    bruto.match(/SerieRps\s*[=:]\s*(\S+)/i)?.[1] ||
    bruto.match(/Serie\s*[=:]\s*(\S+)/i)?.[1] ||
    base.serie ||
    "1";
  return {
    ...base,
    chave: chaveNfse || base.chave,
    numero: numeroNfse || base.numero,
    serie,
  };
}

function normalizarResultadoNfse(p, resposta) {
  const docs = require("../../documentosFiscais");
  const xml = docs.extrairXmlDaResposta(resposta);
  return {
    chave: p.chave,
    numero: p.numero,
    serie: p.serie || "1",
    protocolo: p.protocolo,
    cStat: p.cStat || "100",
    xMotivo: p.xMotivo,
    xml,
    fiscal: true,
    modeloDocumento: "99",
    chaveNfse: p.chave,
    numeroNfse: p.numero,
    serieRps: p.serie,
  };
}

async function emitirNfseCore(payload) {
  validarPayloadNfse(payload);

  const fiscalIniPolicy = require("../fiscalIniPolicy");
  let iniBase;
  if (payload.documentIni && String(payload.documentIni).trim()) {
    iniBase = String(payload.documentIni);
  } else {
    fiscalIniPolicy.requireDocumentIniOrAllowLocal(payload, "NFS-e");
    throw new Error("documentIni obrigatório para NFS-e");
  }

  const ref = payload.numeroRps || payload.numeroVenda || Date.now();
  const iniPath = path.join(PATHS.ini, `nfse-${ref}-${Date.now()}.ini`);
  fs.writeFileSync(iniPath, iniBase, "utf8");

  const resposta = await acbr.enviarComando(
    `NFSe.CriarEnviar(${qAcbr(iniPath)},1,0,1,0)`,
    ACBR_TIMEOUT_EMISSAO,
  );
  const p = parseRespostaNfse(resposta);
  if (!p.chave && !p.numero) {
    const err = new Error(
      `ACBr não retornou identificador NFS-e. Resposta: ${String(resposta).slice(0, 500)}`,
    );
    if (/rejeit|erro|falha/i.test(String(resposta))) err.permanente = true;
    throw err;
  }
  return normalizarResultadoNfse(p, resposta);
}

async function emitirNfse(payload) {
  if (!acbr.isNfseHabilitado()) return { fiscal: false };
  return fiscalEmissionLock.withEmissionLock(
    () => emitirNfseCore(payload),
    "monitor-nfse",
  );
}

module.exports = {
  emitirNfse,
  emitirNfseCore,
  parseRespostaNfse,
  normalizarResultadoNfse,
};
