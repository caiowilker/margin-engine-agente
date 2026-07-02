// Auto-update via manifest.json local + rollback
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { getDirectoryManager } = require("./runtime/directoryManager");

const MANIFEST_PATH = path.join(__dirname, "manifest.json");

function backupDir() {
  return getDirectoryManager().file("agent", "backup-pre-update");
}

let manifestBootOk = true;
let manifestBootMotivo = null;

function calcularSha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function lerManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function validarManifest(manifest, baseDir = __dirname) {
  if (!manifest?.arquivos?.length) throw new Error("manifest.json inválido");
  for (const item of manifest.arquivos) {
    if (!item.sha256 || String(item.sha256).trim() === "") {
      throw new Error(`SHA-256 ausente no manifest: ${item.arquivo}`);
    }
    const fp = path.join(baseDir, item.arquivo);
    if (!fs.existsSync(fp)) throw new Error(`Arquivo ausente: ${item.arquivo}`);
    const sha = calcularSha256(fp);
    if (sha.toLowerCase() !== String(item.sha256).toLowerCase()) {
      throw new Error(`SHA-256 divergente: ${item.arquivo}`);
    }
  }
  return true;
}

function verificarManifestBoot() {
  manifestBootOk = true;
  manifestBootMotivo = null;
  const manifest = lerManifest();
  if (!manifest?.arquivos?.length) {
    manifestBootOk = false;
    manifestBootMotivo = "manifest.json ausente ou inválido";
    return { ok: false, motivo: manifestBootMotivo };
  }
  try {
    validarManifest(manifest);
    return { ok: true };
  } catch (err) {
    manifestBootOk = false;
    manifestBootMotivo = err.message;
    return { ok: false, motivo: manifestBootMotivo };
  }
}

function isManifestOk() {
  return manifestBootOk;
}

function getManifestBootMotivo() {
  return manifestBootMotivo;
}

function backupArquivos(arquivos) {
  const root = backupDir();
  getDirectoryManager().ensurePath(root, "agentData");
  const stamp = Date.now();
  const dir = path.join(root, String(stamp));
  fs.mkdirSync(dir, { recursive: true });
  for (const nome of arquivos) {
    const src = path.join(__dirname, nome);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, nome));
    }
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ arquivos }, null, 2));
  return dir;
}

function rollbackDisponivel() {
  const root = backupDir();
  if (!fs.existsSync(root)) return false;
  return fs
    .readdirSync(root)
    .some((d) => fs.statSync(path.join(root, d)).isDirectory());
}

function ultimoBackupInfo() {
  const root = backupDir();
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dirs.length) return null;
  const st = fs.statSync(dirs[0]);
  return {
    quando: new Date(st.mtimeMs).toISOString(),
    pasta: dirs[0],
  };
}

function rollbackUltimo() {
  const root = backupDir();
  if (!fs.existsSync(root)) throw new Error("Nenhum backup disponível");
  const dirs = fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dirs.length) throw new Error("Nenhum backup disponível");
  const dir = dirs[0];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
  );
  for (const nome of manifest.arquivos) {
    const src = path.join(dir, nome);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(__dirname, nome));
    }
  }
  return dir;
}

async function aplicarPacote(tmpDir, shaEsperado, novaVersao) {
  const manifestSrc = path.join(tmpDir, "manifest.json");
  if (!fs.existsSync(manifestSrc)) {
    throw new Error("Pacote sem manifest.json");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, "utf8"));
  validarManifest(manifest, tmpDir);

  if (shaEsperado) {
    const zipPath = path.join(tmpDir, "package.zip");
    if (fs.existsSync(zipPath)) {
      const sha = calcularSha256(zipPath);
      if (sha.toLowerCase() !== String(shaEsperado).toLowerCase()) {
        throw new Error("SHA-256 do pacote não confere");
      }
    }
  }

  const nomes = manifest.arquivos.map((a) => a.arquivo);
  backupArquivos(nomes);

  for (const item of manifest.arquivos) {
    const src = path.join(tmpDir, item.arquivo);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(__dirname, item.arquivo));
    }
  }

  return { versao: novaVersao || manifest.versao, arquivos: nomes.length };
}

module.exports = {
  lerManifest,
  validarManifest,
  verificarManifestBoot,
  isManifestOk,
  getManifestBootMotivo,
  calcularSha256,
  backupArquivos,
  rollbackUltimo,
  rollbackDisponivel,
  ultimoBackupInfo,
  aplicarPacote,
  MANIFEST_PATH,
};
