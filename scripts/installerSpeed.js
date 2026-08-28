/**
 * Decisões de velocidade do instalador Windows.
 * Extração = Inno Setup. O bootstrap no caixa não refaz npm/hash/ACL em árvore
 * quando o pacote já veio completo e coerente do prepare-build.
 */
const fs = require("fs");
const path = require("path");

function packagedInstall(appDir, existsFn = fs.existsSync) {
  return existsFn(path.join(appDir, "BUILD_STAMP.json"));
}

function shouldSkipNpmCi({ nativeReady }) {
  return Boolean(nativeReady);
}

/**
 * Presença rápida (stat) — não calcula SHA-256.
 * Recusa manifest que ainda lista .br/.gz (pacote antigo vs SPA sem CDN).
 */
function manifestEntriesPresent(
  appDir,
  existsFn = fs.existsSync,
  readFileFn = (fp) => fs.readFileSync(fp, "utf8"),
) {
  const fp = path.join(appDir, "manifest.json");
  if (!existsFn(fp)) return false;
  let manifest;
  try {
    manifest = JSON.parse(readFileFn(fp));
  } catch {
    return false;
  }
  const arquivos = manifest && manifest.arquivos;
  if (!Array.isArray(arquivos) || arquivos.length === 0) return false;
  for (const item of arquivos) {
    const rel = item && item.arquivo;
    if (!rel || typeof rel !== "string") return false;
    if (/\.(br|gz)$/i.test(rel)) return false;
    const abs = path.join(appDir, rel);
    if (!existsFn(abs)) return false;
  }
  return true;
}

function shouldSkipManifestRegen({
  nativeReady,
  packaged,
  manifestPresent = true,
  entriesPresent = true,
}) {
  return Boolean(nativeReady && packaged && manifestPresent && entriesPresent);
}

function shouldSkipPredeploy({ nativeReady, packaged }) {
  return Boolean(nativeReady && packaged);
}

/**
 * Install/update: herança na raiz (rápido).
 * Repair: /T corrige ACL já quebrada em XML/logs existentes.
 */
function icaclsGrantCommand(root, { recurse = false } = {}) {
  const tree = recurse ? " /T" : "";
  return `icacls "${root}" /grant *S-1-5-32-545:(OI)(CI)M${tree} /C`;
}

/** 1º boot: Defender + ACBr grace podem passar de 90s; sucesso retorna antes. */
const INSTALL_WAIT_ONLINE_MS = 120_000;
const INSTALL_WAIT_RETRY_MS = 60_000;
/** Teto de espera ativa do agente no bootstrap (1ª passagem + retry; auto-reparo é extra). */
const INSTALL_BOOTSTRAP_MAX_MS = 180_000;

function remainingBootstrapBudgetMs(startedAtMs, nowMs = Date.now()) {
  return Math.max(5_000, INSTALL_BOOTSTRAP_MAX_MS - (nowMs - startedAtMs));
}

function clampWaitMs(requestedMs, startedAtMs, nowMs = Date.now()) {
  return Math.min(requestedMs, remainingBootstrapBudgetMs(startedAtMs, nowMs));
}

module.exports = {
  packagedInstall,
  shouldSkipNpmCi,
  manifestEntriesPresent,
  shouldSkipManifestRegen,
  shouldSkipPredeploy,
  icaclsGrantCommand,
  INSTALL_WAIT_ONLINE_MS,
  INSTALL_WAIT_RETRY_MS,
  INSTALL_BOOTSTRAP_MAX_MS,
  remainingBootstrapBudgetMs,
  clampWaitMs,
};
