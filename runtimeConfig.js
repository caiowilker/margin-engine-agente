// Config operacional em runtime — prioridade: backend > último conhecido > .env boot
const catalog = require("./agentConfigCatalog");
const log = require("./logger").child({ modulo: "runtime_config" });

let operacional = null;
let fonte = "env";

function getFonte() {
  return fonte;
}

function getOperacional() {
  if (operacional) return { ...operacional };
  return catalog.mesclarComDefaults(
    Object.fromEntries(
      Object.keys(catalog.CATALOGO).map((k) => [k, catalog.lerEnvFallback(k)]),
    ),
  );
}

function get(chave) {
  const merged = getOperacional();
  return merged[chave];
}

function aplicarRemoto(cfg) {
  const raw =
    cfg && typeof cfg === "object" && cfg.operacional && typeof cfg.operacional === "object"
      ? cfg.operacional
      : cfg;
  if (!raw || typeof raw !== "object") return getOperacional();
  const merged = catalog.mesclarComDefaults(raw);
  operacional = merged;
  fonte = "backend";
  catalog.aplicarNoProcessEnv(merged);
  if (merged.ambienteSefaz) {
    try {
      require("./fiscalLocalConfig").aplicarAmbiente(String(merged.ambienteSefaz));
    } catch (err) {
      log.warn({ err: err.message }, "[RuntimeConfig] Falha ao sincronizar ambiente no acbrlib.ini");
    }
  }
  log.debug("[RuntimeConfig] Config operacional aplicada via backend");
  return merged;
}

function manterUltimoConhecido() {
  if (operacional) fonte = "ultimo_conhecido";
  else fonte = "env";
}

function initFromEnv() {
  operacional = catalog.mesclarComDefaults(
    Object.fromEntries(
      Object.keys(catalog.CATALOGO).map((k) => [k, catalog.lerEnvFallback(k)]),
    ),
  );
  fonte = "env";
}

initFromEnv();

module.exports = {
  get,
  getOperacional,
  getFonte,
  aplicarRemoto,
  manterUltimoConhecido,
  initFromEnv,
};
