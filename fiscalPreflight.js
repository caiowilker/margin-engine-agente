// Validação operacional A1/CSC/ambiente via ACBr — cache para não bloquear cada venda
const fs = require("fs");
const fiscalDriver = require("./fiscalDriver");
const fiscalDriverNfceSetup = require("./fiscalDriverNfceSetup");
const fiscalLocalConfig = require("./fiscalLocalConfig");
const factory = require("./fiscal/factory");

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

function ambienteConfigurado() {
  try {
    return fiscalLocalConfig.ler().ambienteSefaz || "homologacao";
  } catch {
    return (process.env.AMBIENTE_SEFAZ || "homologacao").toLowerCase().trim();
  }
}

function isLibDriver() {
  const name = String(process.env.ACBR_DRIVER || factory.resolveDriverName() || "monitor")
    .toLowerCase()
    .replace("acbr-lib", "lib");
  return name === "lib";
}

function validarAmbienteConfigurado(ambienteEsperado) {
  const cfgAmb = ambienteConfigurado();
  if (cfgAmb !== ambienteEsperado) {
    throw new Error(
      `AMBIENTE_SEFAZ=${ambienteEsperado} mas configuração fiscal local está em ${cfgAmb}`,
    );
  }
  return cfgAmb;
}

async function validarSefazOperacional() {
  const resposta = await fiscalDriver.statusServico();
  const p = fiscalDriver.parseResposta(
    typeof resposta === "object" && resposta.raw != null ? resposta.raw : resposta,
  );
  const cStat = p.cStat || resposta?.cStat;
  const xMotivo = p.xMotivo || resposta?.xMotivo;
  if (!cStat) {
    throw new Error(
      `Emissor fiscal não retornou status do serviço NFC-e. Resposta: ${JSON.stringify(resposta)}`,
    );
  }
  if (cStat !== "107" && cStat !== "108") {
    throw new Error(`SEFAZ indisponível (cStat ${cStat}): ${xMotivo || resposta}`);
  }
  return {
    resposta: typeof resposta === "object" ? resposta.raw || JSON.stringify(resposta) : resposta,
    p: { ...p, cStat, xMotivo },
  };
}

function validarAmbiente(ambienteEsperado, resposta, p) {
  const ambAcbr =
    extrairValor(resposta, "tpAmb") ||
    extrairValor(resposta, "Ambiente") ||
    extrairValor(resposta, "TipoAmbiente") ||
    p.tpAmb ||
    "";
  if (!ambAcbr) return ambAcbr;

  const fiscalDriverHomolog = ambienteAcbrHomologacao(ambAcbr);
  const fiscalDriverProd = ambienteAcbrProducao(ambAcbr);
  if (ambienteEsperado === "homologacao" && fiscalDriverProd && !fiscalDriverHomolog) {
    throw new Error(
      `AMBIENTE_SEFAZ=homologacao mas emissor fiscal está em produção (tpAmb=${ambAcbr})`,
    );
  }
  if (ambienteEsperado === "producao" && fiscalDriverHomolog && !fiscalDriverProd) {
    throw new Error(
      `AMBIENTE_SEFAZ=producao mas emissor fiscal está em homologação (tpAmb=${ambAcbr})`,
    );
  }
  return ambAcbr;
}

/** Caminho quente: 1 round-trip TCP (StatusServico). Usado antes de cada emissão. */
async function validarEmissaoRapida() {
  if (!fiscalDriver.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }
  if (cacheValido(cacheRapido)) return cacheRapido.resultado;

  const ambienteEsperado = ambienteConfigurado();
  validarAmbienteConfigurado(ambienteEsperado);

  let resposta;
  let p;
  try {
    ({ resposta, p } = await validarSefazOperacional());
  } catch (err) {
    cacheRapido = null;
    throw new Error(`Emissor fiscal indisponível: ${err.message}`);
  }

  const ambAcbr = validarAmbiente(ambienteEsperado, resposta, p);

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
  if (!fiscalDriver.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }
  if (cacheValido(cacheCompleto)) return cacheCompleto.resultado;

  const ambienteEsperado = ambienteConfigurado();
  validarAmbienteConfigurado(ambienteEsperado);

  const { resposta, p } = await validarSefazOperacional();
  const ambAcbr = validarAmbiente(ambienteEsperado, resposta, p);

  if (!isLibDriver()) {
    try {
      const certResp = await fiscalDriver.enviarNfe("NFE.CertificadoDataVencimento");
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
  }

  const cfg = fiscalLocalConfig.ler();
  const certPath =
    cfg.certificado?.arquivoAbsoluto ||
    process.env.CERT_A1_PATH ||
    cfg.certificado?.arquivo;
  if (certPath && !fs.existsSync(certPath)) {
    throw new Error(`Certificado A1 não encontrado: ${certPath}`);
  }
  if (isLibDriver() && !cfg.certificado?.senhaConfigurada) {
    throw new Error("Senha do certificado A1 não configurada (Configuração fiscal).");
  }

  const nfceSetup = await fiscalDriverNfceSetup.validarAsync();

  const resultado = {
    ok: true,
    fiscal: true,
    modo: "completo",
    ambienteEsperado,
    ambienteAcbr: ambAcbr || null,
    cStat: p.cStat,
    xMotivo: p.xMotivo,
    nfceSetup,
    acoes: nfceSetup.acoes || [],
  };

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
