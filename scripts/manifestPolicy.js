/**
 * Política do pacote de update remoto (update.zip).
 *
 * Inclui código JS/JSON operacional do agente + SPA embutida.
 * NÃO inclui nativos, DLLs, node_modules nem dados do cliente —
 * esses continuam exclusivos do instalador Windows (/MODE=update).
 */
const fs = require("fs");
const path = require("path");

/** Diretórios cujo conteúdo (recursivo) entra no update remoto. */
const INCLUDE_DIRS = Object.freeze([
  "print",
  "fiscal",
  "runtime",
  "storage",
  "frontend-dist",
]);

/**
 * Arquivos na raiz do agente sempre incluídos (além dos *.js).
 * package.json é obrigatório — sem ele VERSAO_ATUAL não muda após o apply.
 */
const INCLUDE_ROOT_FILES = Object.freeze(["package.json", "VERSION"]);

/**
 * Diretórios ignorados **somente na raiz** do agente (não em subpastas).
 * Ex.: `assets/` do instalador ≠ `frontend-dist/assets/` do Vite.
 */
const EXCLUDE_ROOT_DIRS = Object.freeze(
  new Set([
    "node_modules",
    ".git",
    ".github",
    "test",
    "tests",
    "scripts",
    "docs",
    ".ai",
    "build",
    "dist",
    "data",
    "Logs",
    "logs",
    "homolog-acbrlib",
    "acbrlib",
    "assets",
    "lib",
    "coverage",
    ".update-staging",
    "frontend-dist", // walk dedicado via INCLUDE_DIRS
    "print",
    "fiscal",
    "runtime",
    "storage",
  ]),
);

/** Nomes de diretório ignorados em qualquer profundidade. */
const EXCLUDE_DIR_NAMES = Object.freeze(
  new Set(["node_modules", ".git", ".github", "coverage", ".update-staging"]),
);

/** Extensões que nunca vão no ZIP remoto (exigem instalador). */
const EXCLUDE_EXTENSIONS = Object.freeze(
  new Set([
    ".node",
    ".dll",
    ".so",
    ".dylib",
    ".exe",
    ".msi",
    ".pdb",
    ".lib",
    ".obj",
    ".zip",
    ".7z",
    ".rar",
    ".map",
  ]),
);

/** Arquivos na raiz que não entram mesmo sendo .js. */
const EXCLUDE_ROOT_FILES = Object.freeze(
  new Set([
    // gerado no apply; não listar a si mesmo (hash circular)
    "manifest.json",
  ]),
);

/**
 * O que NUNCA deve ser atualizado pelo canal ZIP — use instalador.
 */
const REQUER_INSTALADOR = Object.freeze([
  "node_modules (deps npm / binários nativos)",
  "DLLs ACBrLib / PosPrinter (acbrlib/)",
  "Node embutido do instalador",
  "Dados e config em %ProgramData%\\MarginEngine",
  "Certificado A1, CSC, .env da loja",
]);

function isExcludedExtension(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return EXCLUDE_EXTENSIONS.has(ext);
}

function deveIncluirArquivo(relPosix) {
  const base = path.posix.basename(relPosix);
  if (base.startsWith(".")) return false;
  if (isExcludedExtension(base)) return false;
  if (base === "manifest.json") return false;
  if (/\.test\.js$/i.test(base) || /\.spec\.js$/i.test(base)) return false;
  return true;
}

function walkDir(absDir, relPrefix, out) {
  if (!fs.existsSync(absDir)) return;
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (EXCLUDE_DIR_NAMES.has(name)) continue;
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    const abs = path.join(absDir, name);
    if (ent.isDirectory()) {
      walkDir(abs, rel, out);
      continue;
    }
    if (!ent.isFile()) continue;
    const relPosix = rel.replace(/\\/g, "/");
    if (!deveIncluirArquivo(relPosix)) continue;
    out.push(relPosix);
  }
}

/**
 * Lista caminhos relativos (posix) que devem entrar no manifest / update.zip.
 * @param {string} rootDir — raiz do agente
 * @returns {string[]}
 */
function listarArquivosUpdate(rootDir) {
  const root = path.resolve(rootDir);
  const set = new Set();

  for (const nome of INCLUDE_ROOT_FILES) {
    const abs = path.join(root, nome);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      set.add(nome);
    }
  }

  for (const name of fs.readdirSync(root)) {
    if (EXCLUDE_ROOT_DIRS.has(name)) continue;
    if (EXCLUDE_ROOT_FILES.has(name)) continue;
    const abs = path.join(root, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!name.endsWith(".js")) continue;
    if (!deveIncluirArquivo(name)) continue;
    set.add(name);
  }

  const collected = [];
  for (const dir of INCLUDE_DIRS) {
    walkDir(path.join(root, dir), dir, collected);
  }
  for (const rel of collected) set.add(rel);

  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Validações mínimas de um manifest gerado (falha o release se faltar).
 * @param {string[]} arquivos
 */
function validarCoberturaObrigatoria(arquivos) {
  const set = new Set(arquivos);
  const faltando = [];
  const obrigatorios = [
    "package.json",
    "index.js",
    "manifestUpdater.js",
    "updaterRemoteCheck.js",
    "updaterVersion.js",
    "print/qrCodeAcbrBmp.js",
    "print/cupomAcbrTags.js",
    "fiscal/factory.js",
    "runtime/directoryManager.js",
  ];
  for (const o of obrigatorios) {
    if (!set.has(o)) faltando.push(o);
  }
  if (!arquivos.some((a) => a.startsWith("print/"))) faltando.push("print/**");
  if (!arquivos.some((a) => a.startsWith("fiscal/"))) faltando.push("fiscal/**");
  if (!arquivos.some((a) => a.startsWith("runtime/"))) faltando.push("runtime/**");
  return { ok: faltando.length === 0, faltando };
}

function resumirPolitica() {
  return {
    includeDirs: [...INCLUDE_DIRS],
    includeRootFiles: [...INCLUDE_ROOT_FILES],
    excludeRootDirs: [...EXCLUDE_ROOT_DIRS],
    excludeDirNames: [...EXCLUDE_DIR_NAMES],
    excludeExtensions: [...EXCLUDE_EXTENSIONS],
    requerInstalador: [...REQUER_INSTALADOR],
  };
}

module.exports = {
  INCLUDE_DIRS,
  INCLUDE_ROOT_FILES,
  EXCLUDE_ROOT_DIRS,
  EXCLUDE_DIR_NAMES,
  EXCLUDE_EXTENSIONS,
  EXCLUDE_ROOT_FILES,
  REQUER_INSTALADOR,
  listarArquivosUpdate,
  validarCoberturaObrigatoria,
  resumirPolitica,
  deveIncluirArquivo,
};
