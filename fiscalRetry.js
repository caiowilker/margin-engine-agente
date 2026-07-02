// Classificação de erros fiscais ACBr/SEFAZ para retry inteligente (Fase 06 T1)

const REJEICAO_PERMANENTE_CSTAT = new Set([
  "203", // Emissor não habilitado
  "204", // Duplicidade de NF-e
  "213", // CNPJ emitente inválido
  "226", // Código da UF diverge
  "280", // Certificado vencido
  "281", // Certificado revogado
  "290", // Certificado com erro
  "301", // Uso denegado
  "539", // Duplicidade (NFC-e)
  "391", // Cartão crédito/débito sem dados de pagamento
  "869", // Valor do troco incorreto
  "685", // vTotTrib total difere do somatório dos itens
]);

/** cStat 999 = erro genérico SEFAZ — no máximo 2 retentativas (evita bloqueio MG regra 656) */
const REJEICAO_TRANSIENTE_CSTAT = new Set(["999"]);
/** Status de lote — não são rejeição da nota */
const CSTAT_LOTE_OK = new Set(["103", "104"]);
const MAX_TENTATIVAS_PADRAO = 10;
const MAX_TENTATIVAS_999 = parseInt(process.env.FISCAL_MAX_RETRY_999 || "2", 10);

const TRANSIENTE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /tempo esgotado/i,
  /inacess[ií]vel/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /503/,
  /500/,
  /socket hang up/i,
  /acbr.*offline|monitor.*offline/i,
  /biblioteca.*n[aã]o/i,
  /invalid handle|access violation/i,
];

function extrairCStat(err) {
  if (!err) return null;
  if (err.cStat) return String(err.cStat);
  const msg = err.message || String(err);
  const m = msg.match(/cStat[=:]?\s*(\d{3})/i);
  return m ? m[1] : null;
}

function isPermanente(err) {
  const cStat = extrairCStat(err);
  if (cStat && REJEICAO_TRANSIENTE_CSTAT.has(cStat)) return false;
  if (err?.permanente) return true;
  if (cStat && REJEICAO_PERMANENTE_CSTAT.has(cStat)) {
    return true;
  }
  const msg = err?.message || String(err || "");
  if (/certificado.*(venc|expir|inv[aá]lid)/i.test(msg)) return true;
  if (/csc.*inv[aá]lid/i.test(msg)) return true;
  if (/munic[ií]pio/i.test(msg)) return true;
  if (/dados fiscais incompletos/i.test(msg)) return true;
  if (/\bncm\b/i.test(msg) && /inv[aá]lid|ausente|obrigat/i.test(msg)) return true;
  if (/\bcfop\b/i.test(msg) && /inv[aá]lid|ausente|obrigat/i.test(msg)) return true;
  if (/\bcst\b|\bcsosn\b/i.test(msg) && /inv[aá]lid|ausente|obrigat/i.test(msg)) return true;
  if (/not a valid time|n[aã]o [eé] um(a)? valor v[aá]lido.*time/i.test(msg)) return true;
  if (/dhEmi|dhSaiEnt|formato de data/i.test(msg) && /inv[aá]lid|valid time/i.test(msg)) return true;
  if (/c[oó]digo ibge/i.test(msg)) return true;
  if (/url-qrcode/i.test(msg)) return true;
  if (/acbrnfeservicos/i.test(msg)) return true;
  if (/csc/i.test(msg) && /n[aã]o/i.test(msg)) return true;
  if (
    /rejei[cç][aã]o|rejeitada/i.test(msg) &&
    cStat &&
    cStat !== "100" &&
    cStat !== "150" &&
    !CSTAT_LOTE_OK.has(cStat) &&
    !REJEICAO_TRANSIENTE_CSTAT.has(cStat)
  ) {
    return true;
  }
  return false;
}

function isIncerto(err) {
  if (err?.incerto) return true;
  const cStat = extrairCStat(err);
  if (cStat && CSTAT_LOTE_OK.has(cStat)) return true;
  return false;
}

function isTransient(err) {
  if (isIncerto(err)) return true;
  const cStat = extrairCStat(err);
  if (cStat && REJEICAO_TRANSIENTE_CSTAT.has(cStat)) return true;
  const msg = err?.message || String(err || "");
  return TRANSIENTE_PATTERNS.some((re) => re.test(msg));
}

function maxTentativas(err) {
  const cStat = extrairCStat(err);
  if (cStat === "999") return MAX_TENTATIVAS_999;
  return MAX_TENTATIVAS_PADRAO;
}

function mensagem999Exaurido(tentativas) {
  return (
    `NFC-e rejeitada (cStat 999): SEFAZ indisponível ou bloqueio por excesso de tentativas. ` +
    `Aguarde 30–60 min e tente uma nova venda. (${tentativas} tentativa(s))`
  );
}

function acaoParaCStat(cStat) {
  const cs = String(cStat || "");
  if (cs === "539" || cs === "204") return "consultar_chave";
  if (cs === "280" || cs === "281" || cs === "290") return "renovar_certificado";
  if (cs.startsWith("2")) return "corrigir_cadastro";
  return "retry";
}

function enriquecerErro(err) {
  if (!err) return err;
  if (isPermanente(err)) err.permanente = true;
  if (isIncerto(err)) err.incerto = true;
  try {
    const meta = require("./fiscal/fiscalMotivo").classificarDeErro(err);
    err.motivoFiscal = meta.motivoFiscal;
    err.recuperavel = meta.recuperavel;
    err.acaoSugerida = meta.acaoSugerida;
  } catch (_) {}
  return err;
}

module.exports = {
  REJEICAO_PERMANENTE_CSTAT,
  REJEICAO_TRANSIENTE_CSTAT,
  extrairCStat,
  isPermanente,
  isIncerto,
  isTransient,
  maxTentativas,
  mensagem999Exaurido,
  acaoParaCStat,
  enriquecerErro,
};
