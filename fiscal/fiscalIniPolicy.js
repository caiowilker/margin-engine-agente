/**
 * Política de montagem de INI fiscal no agente.
 * Produção 1.0: INI deve vir do Margin Engine (documentIni / MFCS).
 * Montagem local (acbr.montarIniNfce) só em:
 * - homolog explícita (FISCAL_ALLOW_LOCAL_INI / HOMOLOG_ACBRLIB), ou
 * - contingência NFC-e comprovada (arquivo ativo, auto-offline, ou flag + evidência do PDV).
 * Nunca no fluxo online normal sem contingência.
 */
function isTruthyEnv(name) {
  return String(process.env[name] || "")
    .trim()
    .toLowerCase() === "true";
}

function lerContingenciaOffline() {
  try {
    return require("./contingenciaOffline");
  } catch (_) {
    return null;
  }
}

/**
 * Evidência de contingência NFC-e — evita bypass MFCS só com flag solta.
 */
function contingenciaNfcePermiteIniLocal(payload) {
  const offline = lerContingenciaOffline();
  if (offline?.isContingenciaOperacionalAtiva?.()) return true;

  const flagPdv = payload?.permitirIniLocalContingencia === true;
  if (!flagPdv) return false;

  // Auto-probe off-line ligado no agente
  if (offline?.isEnabled?.()) return true;

  // PDV confirma contingência ativa (mesmo status que o painel leu do agente)
  if (
    payload?.contingenciaAtiva === true ||
    payload?.contingenciaOffline === true
  ) {
    return true;
  }

  return false;
}

function allowLocalIniBuild(payload) {
  if (isTruthyEnv("FISCAL_ALLOW_LOCAL_INI")) return true;
  if (isTruthyEnv("HOMOLOG_ACBRLIB")) return true;
  return contingenciaNfcePermiteIniLocal(payload || {});
}

/**
 * @param {object} payload
 * @param {string} contextLabel — "NFC-e" | "NF-e" | "NFS-e"
 * Contingência só libera montagem local para NFC-e (65).
 */
function requireDocumentIniOrAllowLocal(payload, contextLabel) {
  const ini = payload?.documentIni;
  if (ini && String(ini).trim()) return;
  const isNfce = String(contextLabel || "").toUpperCase().includes("NFC");
  if (isNfce && allowLocalIniBuild(payload)) return;
  if (
    !isNfce &&
    (isTruthyEnv("FISCAL_ALLOW_LOCAL_INI") || isTruthyEnv("HOMOLOG_ACBRLIB"))
  ) {
    return;
  }
  const err = new Error(
    `documentIni obrigatório para ${contextLabel}: o agente não monta INI fiscal em produção. ` +
      "Use o Margin Engine (MFCS) ou habilite FISCAL_ALLOW_LOCAL_INI apenas em homologação. " +
      "Em contingência NFC-e ativa, o INI local é permitido sem prepare.",
  );
  err.permanente = true;
  throw err;
}

module.exports = {
  allowLocalIniBuild,
  contingenciaNfcePermiteIniLocal,
  requireDocumentIniOrAllowLocal,
};
