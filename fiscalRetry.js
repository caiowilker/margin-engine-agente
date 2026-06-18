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
  "999", // Erro não catalogado permanente comum
]);

const TRANSIENTE_PATTERNS = [
  /timeout/i,
  /inacess[ií]vel/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /503/,
  /500/,
  /socket hang up/i,
];

function extrairCStat(err) {
  if (!err) return null;
  if (err.cStat) return String(err.cStat);
  const msg = err.message || String(err);
  const m = msg.match(/cStat[=:]?\s*(\d{3})/i);
  return m ? m[1] : null;
}

function isPermanente(err) {
  if (err?.permanente) return true;
  const cStat = extrairCStat(err);
  if (cStat && REJEICAO_PERMANENTE_CSTAT.has(cStat)) {
    return true;
  }
  const msg = err?.message || String(err || "");
  if (/certificado.*(venc|expir|inv[aá]lid)/i.test(msg)) return true;
  if (/csc.*inv[aá]lid/i.test(msg)) return true;
  if (/rejei[cç][aã]o/i.test(msg) && cStat && cStat.startsWith("2")) {
    return true;
  }
  return false;
}

function isIncerto(err) {
  return Boolean(err?.incerto);
}

function isTransient(err) {
  if (isIncerto(err)) return true;
  const msg = err?.message || String(err || "");
  return TRANSIENTE_PATTERNS.some((re) => re.test(msg));
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
  return err;
}

module.exports = {
  REJEICAO_PERMANENTE_CSTAT,
  extrairCStat,
  isPermanente,
  isIncerto,
  isTransient,
  acaoParaCStat,
  enriquecerErro,
};
