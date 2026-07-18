// Auto-update via manifest.json local + rollback
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDirectoryManager } = require("./runtime/directoryManager");
const { isDowngrade } = require("./updaterVersion");

let agentRootOverride = null;

function agentRoot() {
  return agentRootOverride || __dirname;
}

function manifestPath() {
  return path.join(agentRoot(), "manifest.json");
}

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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copiarArquivoPara(destAbs, srcAbs) {
  ensureParentDir(destAbs);
  fs.copyFileSync(srcAbs, destAbs);
}

function lerManifest() {
  const fp = manifestPath();
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function validarManifest(manifest, baseDir = agentRoot()) {
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

  const lista = [...new Set(arquivos.filter(Boolean))];
  for (const nome of lista) {
    if (nome === "manifest.json") continue;
    const src = path.join(agentRoot(), nome);
    if (fs.existsSync(src)) {
      copiarArquivoPara(path.join(dir, nome), src);
    }
  }

  // Manifest real do agente (separado do índice)
  const manifestAtual = path.join(agentRoot(), "manifest.json");
  if (fs.existsSync(manifestAtual)) {
    copiarArquivoPara(path.join(dir, "manifest.json"), manifestAtual);
  }

  // Índice do backup (não colide com o manifest do agente)
  const index = { arquivos: lista, formato: 2 };
  fs.writeFileSync(
    path.join(dir, "_backup-index.json"),
    JSON.stringify(index, null, 2),
  );
  // Legado: algumas ferramentas esperavam manifest.json como índice —
  // só grava se não houver manifest do agente (evita sobrescrever o backup real)
  if (!fs.existsSync(manifestAtual)) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(index, null, 2));
  }

  return dir;
}

function lerIndiceBackup(dir) {
  const indexPath = path.join(dir, "_backup-index.json");
  if (fs.existsSync(indexPath)) {
    return {
      formato: 2,
      index: JSON.parse(fs.readFileSync(indexPath, "utf8")),
    };
  }
  // Legado: manifest.json era o índice (não o manifest do agente)
  const legacy = path.join(dir, "manifest.json");
  if (!fs.existsSync(legacy)) throw new Error("Backup sem índice");
  return {
    formato: 1,
    index: JSON.parse(fs.readFileSync(legacy, "utf8")),
  };
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
  const { formato, index } = lerIndiceBackup(dir);
  const nomes = index.arquivos || [];
  for (const nome of nomes) {
    if (nome === "manifest.json") continue;
    const src = path.join(dir, nome);
    if (fs.existsSync(src)) {
      copiarArquivoPara(path.join(agentRoot(), nome), src);
    }
  }
  // Formato 2: manifest.json no backup é o manifest real do agente
  if (formato >= 2) {
    const bakManifest = path.join(dir, "manifest.json");
    if (fs.existsSync(bakManifest)) {
      copiarArquivoPara(path.join(agentRoot(), "manifest.json"), bakManifest);
    }
  }
  return dir;
}

function lerVersaoInstalada() {
  try {
    const pkgPath = path.join(agentRoot(), "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ? String(pkg.version).trim() : null;
  } catch {
    return null;
  }
}

async function aplicarPacote(tmpDir, shaEsperado, novaVersao) {
  const manifestSrc = path.join(tmpDir, "manifest.json");
  if (!fs.existsSync(manifestSrc)) {
    throw new Error("Pacote sem manifest.json");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestSrc, "utf8"));
  validarManifest(manifest, tmpDir);

  const versaoPacote = String(novaVersao || manifest.versao || "").trim();
  const versaoAtual = lerVersaoInstalada();
  if (versaoPacote && versaoAtual && isDowngrade(versaoPacote, versaoAtual)) {
    throw new Error(
      `Downgrade bloqueado — pacote v${versaoPacote} é anterior à instalada v${versaoAtual}. Use o instalador apenas para reparo da mesma versão ou superior.`,
    );
  }

  const temPackageJson = manifest.arquivos.some(
    (a) => a.arquivo === "package.json",
  );
  if (!temPackageJson) {
    throw new Error(
      "Pacote inválido — package.json ausente (necessário para versionar o agente após o update)",
    );
  }

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
  // backupArquivos sempre preserva o manifest.json atual do agente (formato 2)
  backupArquivos(nomes);

  for (const item of manifest.arquivos) {
    const src = path.join(tmpDir, item.arquivo);
    if (fs.existsSync(src)) {
      copiarArquivoPara(path.join(agentRoot(), item.arquivo), src);
    }
  }

  // Grava o novo manifest — sem isso o boot seguinte falha SHA contra o manifest antigo
  fs.writeFileSync(
    path.join(agentRoot(), "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  validarManifest(manifest, agentRoot());

  return { versao: versaoPacote || manifest.versao, arquivos: nomes.length };
}

function __setAgentRootForTests(root) {
  agentRootOverride = root;
}

function __resetAgentRootForTests() {
  agentRootOverride = null;
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
  lerVersaoInstalada,
  manifestPath,
  MANIFEST_PATH: manifestPath(),
  __setAgentRootForTests,
  __resetAgentRootForTests,
};
