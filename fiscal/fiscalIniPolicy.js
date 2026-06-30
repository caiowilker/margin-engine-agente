/**
 * Política de montagem de INI fiscal no agente.
 * Produção 1.0: INI deve vir do Margin Engine (documentIni / MFCS).
 * Montagem local (acbr.montarIniNfce/Nfe) só em homolog explícita.
 */
function isTruthyEnv(name) {
  return String(process.env[name] || "")
    .trim()
    .toLowerCase() === "true";
}

function allowLocalIniBuild() {
  if (isTruthyEnv("FISCAL_ALLOW_LOCAL_INI")) return true;
  if (isTruthyEnv("HOMOLOG_ACBRLIB")) return true;
  return false;
}

function requireDocumentIniOrAllowLocal(payload, contextLabel) {
  const ini = payload?.documentIni;
  if (ini && String(ini).trim()) return;
  if (allowLocalIniBuild()) return;
  throw new Error(
    `documentIni obrigatório para ${contextLabel}: o agente não monta INI fiscal em produção. ` +
      "Use o Margin Engine (MFCS) ou habilite FISCAL_ALLOW_LOCAL_INI apenas em homologação.",
  );
}

module.exports = {
  allowLocalIniBuild,
  requireDocumentIniOrAllowLocal,
};
