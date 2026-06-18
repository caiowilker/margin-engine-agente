// Validação operacional A1/CSC/ambiente via ACBr — cache para não bloquear cada venda
const fs = require("fs");
const acbr = require("./acbr");
const acbrNfceSetup = require("./acbrNfceSetup");

const PREFLIGHT_TTL_MS = parseInt(
  process.env.FISCAL_PREFLIGHT_TTL_MS || "90000",
  10,
);
const PREFLIGHT_RAPIDO =
  (process.env.FISCAL_PREFLIGHT_RAPIDO || "true").toLowerCase() === "true";

let cacheRapido = null;
let cacheCompleto = null;

function extrairValor(resposta, chave) {
  const re = new RegExp(`^${chave}\\s*[=:]\\s*(.+)$`, "im");
  for (const linha of String(resposta || "").split(/\r?\n/)) {
    const m = linha.trim().match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function ambienteAcbrHomologacao(valor) {
  const t = String(valor || "").toUpperCase();
  return t.includes("HOMOLOG") || t === "2";
}

function ambienteAcbrProducao(valor) {
  const t = String(valor || "").toUpperCase();
  return t.includes("PRODUC") || t === "1";
}

function cacheValido(entry) {
  return entry && Date.now() - entry.em < PREFLIGHT_TTL_MS;
}

async function validarSefazOperacional() {
  const resposta = await acbr.enviarNfe("NFE.StatusServico");
  const p = acbr.parseResposta(resposta);
  if (!p.cStat) {
    throw new Error(
      `ACBr não retornou status do serviço NFC-e. Resposta: ${resposta}`,
    );
  }
  if (p.cStat !== "107" && p.cStat !== "108") {
    throw new Error(
      `SEFAZ indisponível (cStat ${p.cStat}): ${p.xMotivo || resposta}`,
    );
  }
  return { resposta, p };
}

function validarAmbiente(ambienteEsperado, resposta, p) {
  const ambAcbr =
    extrairValor(resposta, "tpAmb") ||
    extrairValor(resposta, "Ambiente") ||
    extrairValor(resposta, "TipoAmbiente") ||
    p.tpAmb ||
    "";
  if (!ambAcbr) return ambAcbr;

  const acbrHomolog = ambienteAcbrHomologacao(ambAcbr);
  const acbrProd = ambienteAcbrProducao(ambAcbr);
  if (ambienteEsperado === "homologacao" && acbrProd && !acbrHomolog) {
    throw new Error(
      "AMBIENTE_SEFAZ=homologacao mas ACBr Monitor está em produção",
    );
  }
  if (ambienteEsperado === "producao" && acbrHomolog && !acbrProd) {
    throw new Error(
      "AMBIENTE_SEFAZ=producao mas ACBr Monitor está em homologação",
    );
  }
  return ambAcbr;
}

/** Caminho quente: 1 round-trip TCP (StatusServico). Usado antes de cada emissão. */
async function validarEmissaoRapida() {
  if (!acbr.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }
  if (cacheValido(cacheRapido)) return cacheRapido.resultado;

  const ambienteEsperado = (process.env.AMBIENTE_SEFAZ || "homologacao")
    .toLowerCase()
    .trim();

  let resposta;
  let p;
  try {
    ({ resposta, p } = await validarSefazOperacional());
  } catch (err) {
    cacheRapido = null;
    throw new Error(`ACBr indisponível: ${err.message}`);
  }

  const ambAcbr = validarAmbiente(ambienteEsperado, resposta, p);

  const setupIni = acbrNfceSetup.validar();
  if (!setupIni.urlQrCodeOk) {
    throw new Error(
      setupIni.acoes?.[0] ||
        "URL-QRCode ausente no ACBr — configure CSC/WebServices no ACBr Monitor antes de emitir.",
    );
  }

  const resultado = {
    ok: true,
    fiscal: true,
    modo: "rapido",
    ambienteEsperado,
    ambienteAcbr: ambAcbr || null,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
  };

  cacheRapido = { em: Date.now(), resultado };
  return resultado;
}

/** Diagnóstico completo: certificado, INI, checklist CSC/URLs. */
async function validarEmissaoCompleta() {
  if (!acbr.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }
  if (cacheValido(cacheCompleto)) return cacheCompleto.resultado;

  const ambienteEsperado = (process.env.AMBIENTE_SEFAZ || "homologacao")
    .toLowerCase()
    .trim();

  const { resposta, p } = await validarSefazOperacional();
  const ambAcbr = validarAmbiente(ambienteEsperado, resposta, p);

  try {
    const certResp = await acbr.enviarNfe("NFE.CertificadoDataVencimento");
    const validade =
      extrairValor(certResp, "DataVencimento") ||
      extrairValor(certResp, "Validade") ||
      certResp.trim();
    const match = validade.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (match) {
      const dt = new Date(`${match[3]}-${match[2]}-${match[1]}`);
      if (!Number.isNaN(dt.getTime()) && dt < new Date()) {
        throw new Error(`Certificado A1 vencido em ${validade}`);
      }
    }
  } catch (err) {
    if (
      err.message.includes("vencido") ||
      err.message.includes("Certificado")
    ) {
      throw err;
    }
  }

  const certPath = process.env.CERT_A1_PATH;
  if (certPath && !fs.existsSync(certPath)) {
    throw new Error(`CERT_A1_PATH não encontrado: ${certPath}`);
  }

  const nfceSetup = await acbrNfceSetup.validarAsync();

  const resultado = {
    ok: nfceSetup.pronto !== false,
    fiscal: true,
    modo: "completo",
    ambienteEsperado,
    ambienteAcbr: ambAcbr || null,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    nfceSetup,
    acoes: nfceSetup.acoes || [],
  };

  if (!nfceSetup.urlQrCodeOk) {
    resultado.ok = false;
    resultado.erro =
      nfceSetup.acoes?.[0] ||
      "URL-QRCode ausente — configure no ACBr Monitor antes de emitir NFC-e.";
  }

  cacheCompleto = { em: Date.now(), resultado };
  return resultado;
}

async function validarEmissao(opcoes = {}) {
  const completo = opcoes.completo === true || !PREFLIGHT_RAPIDO;
  if (completo) return validarEmissaoCompleta();
  return validarEmissaoRapida();
}

function invalidarCache() {
  cacheRapido = null;
  cacheCompleto = null;
}

module.exports = {
  validarEmissao,
  validarEmissaoRapida,
  validarEmissaoCompleta,
  invalidarCache,
  extrairValor,
};
