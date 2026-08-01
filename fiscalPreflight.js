// Validação operacional A1/CSC/ambiente via ACBr — cache para não bloquear cada venda
const fs = require("fs");
const fiscalDriver = require("./fiscalDriver");
const fiscalDriverNfceSetup = require("./fiscalDriverNfceSetup");
const fiscalLocalConfig = require("./fiscalLocalConfig");
const factory = require("./fiscal/factory");

const PREFLIGHT_TTL_MS = parseInt(
  process.env.FISCAL_PREFLIGHT_TTL_MS || "180000",
  10,
);
/** Após o TTL, ainda reutiliza o último StatusServico ok se o ACBr estiver ocupado (evita fila). */
const PREFLIGHT_GRACE_MS = parseInt(
  process.env.FISCAL_PREFLIGHT_GRACE_MS || "120000",
  10,
);
const PREFLIGHT_RAPIDO =
  (process.env.FISCAL_PREFLIGHT_RAPIDO || "true").toLowerCase() === "true";

let cacheRapido = null;
let cacheCompleto = null;
let statusInFlight = null;

function extrairValor(resposta, chave) {
  const re = new RegExp(`^${chave}\\s*[=:]\\s*(.+)$`, "im");
  for (const linha of String(resposta || "").split(/\r?\n/)) {
    const m = linha.trim().match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Interpreta ambiente retornado pelo emissor.
 * @param {string} valor
 * @param {"tpAmb"|"Ambiente"|"auto"} campo
 *   - tpAmb: SEFAZ 1=prod · 2=homolog
 *   - Ambiente: ACBrLib/Monitor enum 0=prod · 1=homolog
 *   - auto: rótulo textual; "2"=homolog; "0"=prod; "1" ambíguo → SEFAZ prod
 * @returns {"producao"|"homologacao"|null}
 */
function interpretarAmbienteResposta(valor, campo = "auto") {
  const t = String(valor ?? "").trim();
  if (!t) return null;
  const u = t.toUpperCase();
  if (u.includes("HOMOLOG")) return "homologacao";
  if (u.includes("PRODUC")) return "producao";

  if (campo === "tpAmb") {
    if (t === "2") return "homologacao";
    if (t === "1") return "producao";
    return null;
  }
  if (campo === "Ambiente") {
    if (t === "0") return "producao";
    if (t === "1") return "homologacao";
    // legado: alguns INIs gravavam tpAmb SEFAZ em Ambiente
    if (t === "2") return "homologacao";
    return null;
  }
  // auto
  if (t === "2") return "homologacao";
  if (t === "0") return "producao";
  if (t === "1") return "producao"; // preferir tpAmb SEFAZ quando o campo é desconhecido
  return null;
}

function ambienteAcbrHomologacao(valor, campo = "auto") {
  return interpretarAmbienteResposta(valor, campo) === "homologacao";
}

function ambienteAcbrProducao(valor, campo = "auto") {
  return interpretarAmbienteResposta(valor, campo) === "producao";
}

function cacheValido(entry) {
  return entry && Date.now() - entry.em < PREFLIGHT_TTL_MS;
}

function cacheAceitavelComGrace(entry) {
  return (
    entry &&
    Date.now() - entry.em < PREFLIGHT_TTL_MS + Math.max(0, PREFLIGHT_GRACE_MS)
  );
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
  // Preferir tpAmb SEFAZ (1/2) quando presente — é o que a SEFAZ autorizou.
  const tpAmbRaw =
    extrairValor(resposta, "tpAmb") ||
    (p?.tpAmb != null && String(p.tpAmb).trim() !== "" ? String(p.tpAmb) : "");
  const ambienteRaw =
    extrairValor(resposta, "Ambiente") ||
    extrairValor(resposta, "TipoAmbiente") ||
    "";

  let resolved = null;
  let ambAcbr = "";
  if (tpAmbRaw) {
    ambAcbr = tpAmbRaw;
    resolved = interpretarAmbienteResposta(tpAmbRaw, "tpAmb");
  } else if (ambienteRaw) {
    ambAcbr = ambienteRaw;
    resolved = interpretarAmbienteResposta(ambienteRaw, "Ambiente");
  }
  if (!ambAcbr) return ambAcbr;
  if (!resolved) return ambAcbr;

  if (ambienteEsperado === "homologacao" && resolved === "producao") {
    throw new Error(
      `AMBIENTE_SEFAZ=homologacao mas emissor fiscal está em produção (valor=${ambAcbr})`,
    );
  }
  if (ambienteEsperado === "producao" && resolved === "homologacao") {
    throw new Error(
      `AMBIENTE_SEFAZ=producao mas emissor fiscal está em homologação (valor=${ambAcbr})`,
    );
  }
  return ambAcbr;
}

/** Caminho quente: StatusServico com cache + single-flight (não martela SEFAZ). */
async function validarEmissaoRapida() {
  if (!fiscalDriver.EMISSAO_FISCAL) {
    return { ok: true, fiscal: false, motivo: "EMISSAO_FISCAL desabilitado" };
  }
  if (cacheValido(cacheRapido)) return cacheRapido.resultado;

  // ACBr ocupado + cache recente em grace → não enfileira StatusServico na frente da emissão.
  try {
    if (
      typeof fiscalDriver.isAcbrBusy === "function" &&
      fiscalDriver.isAcbrBusy() &&
      cacheAceitavelComGrace(cacheRapido)
    ) {
      return cacheRapido.resultado;
    }
  } catch {
    /* ignore */
  }

  if (statusInFlight) return statusInFlight;

  statusInFlight = (async () => {
    const ambienteEsperado = ambienteConfigurado();
    validarAmbienteConfigurado(ambienteEsperado);

    let resposta;
    let p;
    try {
      ({ resposta, p } = await validarSefazOperacional());
    } catch (err) {
      // Se StatusServico falhar mas há grace cache, não derruba venda por glitch transitório.
      if (cacheAceitavelComGrace(cacheRapido)) {
        return cacheRapido.resultado;
      }
      const msg = String(err?.message || err || "");
      if (/void \*\*|unexpected external|invalid handle|sessão nativa|session disposed|em recuperação/i.test(msg)) {
        try {
          if (typeof fiscalDriver.invalidateNativeSession === "function") {
            await fiscalDriver.invalidateNativeSession("koffi_dead");
          }
          if (typeof fiscalDriver.refreshLibRuntimeConfig === "function") {
            /* clearSoftDead já ocorre em operator paths; força recovery explícito */
          }
          try {
            require("./fiscal/drivers/acbrLibSession").clearSoftDead("nfe");
          } catch (_) {}
        } catch (_) {}
        try {
          ({ resposta, p } = await validarSefazOperacional());
        } catch (err2) {
          cacheRapido = null;
          throw new Error(`Emissor fiscal indisponível: ${err2.message}`);
        }
      } else {
        cacheRapido = null;
        throw new Error(`Emissor fiscal indisponível: ${err.message}`);
      }
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
  })().finally(() => {
    statusInFlight = null;
  });

  return statusInFlight;
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
  interpretarAmbienteResposta,
  validarAmbiente,
};
