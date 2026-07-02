/**
 * Taxonomia fail-safe de erros fiscais — alinhada ao PDV (NCM, rede, SEFAZ, timeout, driver).
 */
const fiscalRetry = require("../fiscalRetry");

const MOTIVOS = [
  "NCM",
  "CFOP",
  "CST",
  "NETWORK",
  "SEFAZ",
  "TIMEOUT",
  "DRIVER",
  "CERTIFICADO",
  "CONFIGURACAO",
  "OUTRO",
];

const ACOES = {
  NCM: "Revise o cadastro do produto (NCM) e reenvie a emissão.",
  CFOP: "Revise CFOP do produto ou operação e reenvie.",
  CST: "Revise CST/CSOSN do produto e reenvie.",
  NETWORK: "Verifique a internet; a fila tentará novamente automaticamente.",
  SEFAZ: "Aguarde alguns minutos; a fila tentará novamente automaticamente.",
  TIMEOUT: "A emissão continua na fila — reenvio automático.",
  DRIVER: "Reinicie o serviço Margin Engine; a fila tentará novamente.",
  CERTIFICADO: "Importe certificado A1 válido em Configuração Fiscal.",
  CONFIGURACAO: "Corrija dados do emitente em Configuração Fiscal.",
  OUTRO: "Consulte Diagnóstico → Fila fiscal ou reenvie depois.",
};

function classificarDeMensagem(msg) {
  const e = String(msg || "").toLowerCase();
  if (/\bncm\b/.test(e) || e.includes("ncm inv") || e.includes("ncm ausente")) {
    return { motivoFiscal: "NCM", recuperavel: false };
  }
  if (/\bcfop\b/.test(e)) return { motivoFiscal: "CFOP", recuperavel: false };
  if (/\bcst\b/.test(e) || /\bcsosn\b/.test(e)) {
    return { motivoFiscal: "CST", recuperavel: false };
  }
  if (/certificado|a1|pfx|\.pfx/i.test(e)) {
    return { motivoFiscal: "CERTIFICADO", recuperavel: false };
  }
  if (
    /cnpj|inscri[cç][aã]o|ibge|emitente|dados fiscais|csc|idtoken|url-qrcode/i.test(e)
  ) {
    return { motivoFiscal: "CONFIGURACAO", recuperavel: false };
  }
  if (/timeout|timed out|tempo esgotado/i.test(e)) {
    return { motivoFiscal: "TIMEOUT", recuperavel: true };
  }
  if (
    /econnreset|econnrefused|enotfound|network|offline|socket|inacess|internet|503|500/i.test(
      e,
    )
  ) {
    return { motivoFiscal: "NETWORK", recuperavel: true };
  }
  if (/sefaz|cstat|rejei[cç]/i.test(e)) {
    return { motivoFiscal: "SEFAZ", recuperavel: true };
  }
  if (/acbr|dll|ffi|driver|monitor|biblioteca|emiss[aã]o fiscal j[aá]/i.test(e)) {
    return { motivoFiscal: "DRIVER", recuperavel: true };
  }
  return { motivoFiscal: "OUTRO", recuperavel: false };
}

function classificarDeErro(err) {
  if (!err) {
    return { motivoFiscal: "OUTRO", recuperavel: false, cStat: null };
  }
  const cStat = fiscalRetry.extrairCStat(err);
  const base = classificarDeMensagem(err.message || String(err));
  let recuperavel = base.recuperavel;
  if (fiscalRetry.isIncerto(err)) recuperavel = true;
  else if (fiscalRetry.isTransient(err)) recuperavel = true;
  else if (fiscalRetry.isPermanente(err) && ["NCM", "CFOP", "CST", "CERTIFICADO", "CONFIGURACAO"].includes(base.motivoFiscal)) {
    recuperavel = false;
  }
  return {
    ...base,
    recuperavel,
    cStat,
    acaoSugerida: ACOES[base.motivoFiscal] || ACOES.OUTRO,
  };
}

function enriquecerStatusEmissao(st) {
  if (!st || typeof st !== "object") return st;
  const meta = classificarDeMensagem(st.erro || "");
  let recuperavel = meta.recuperavel;
  if (st.status === "FALHA_TEMPORARIA" || st.status === "INCERTO" || st.status === "RECUPERANDO") {
    recuperavel = true;
  }
  if (st.status === "FALHA_PERMANENTE" && ["NCM", "CFOP", "CST", "CERTIFICADO", "CONFIGURACAO"].includes(meta.motivoFiscal)) {
    recuperavel = false;
  }
  return {
    ...st,
    motivoFiscal: meta.motivoFiscal,
    recuperavel,
    acaoSugerida: ACOES[meta.motivoFiscal] || ACOES.OUTRO,
  };
}

function statusFiscalFailSafe(err) {
  const meta = classificarDeErro(err);
  if (meta.recuperavel || ["NCM", "CFOP", "CST", "CERTIFICADO", "CONFIGURACAO", "DRIVER", "TIMEOUT", "NETWORK", "SEFAZ"].includes(meta.motivoFiscal)) {
    return "PENDENTE_FISCAL";
  }
  return "REJEITADA";
}

module.exports = {
  MOTIVOS,
  classificarDeMensagem,
  classificarDeErro,
  enriquecerStatusEmissao,
  statusFiscalFailSafe,
};
