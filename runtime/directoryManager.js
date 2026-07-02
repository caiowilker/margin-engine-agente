/**
 * DirectoryManager — único ponto de resolução de caminhos do agente.
 *
 * Usa CommonApplicationData, LocalApplicationData, ProgramFiles (APIs Windows).
 * Recria diretórios automaticamente — nunca lança erro por pasta ausente.
 */
const fs = require("fs");
const path = require("path");
const {
  resolveProgramDataRoot,
  resolveProgramFilesRoot,
  resolveTempRoot,
} = require("./windowsEnv");

const LOGICAL_DIRS = [
  "logs",
  "config",
  "backup",
  "cert",
  "fiscalXml",
  "fiscalPdf",
  "fiscalLogs",
  "fiscalBackup",
  "fiscalIni",
  "fiscalConfig",
  "fiscalEntrada",
  "fiscalSaida",
  "fiscalCancelamentos",
  "fila",
  "spool",
  "impressao",
  "temp",
  "cache",
  "diagnostics",
  "agentData",
  "storageRoot",
  "produtosOriginal",
  "produtosMedium",
  "produtosThumb",
  "produtosCache",
  "produtosTemp",
];

let singleton = null;
let fallbackNote = null;

function buildPaths(dataRoot) {
  const root = path.normalize(dataRoot);
  const acbr = path.join(root, "acbr");
  const storage = path.join(root, "Storage");
  const produtos = path.join(storage, "Produtos");

  return {
    root,
    dataRoot: root,
    logs: path.join(root, "Logs"),
    config: path.join(root, "Config"),
    backup: path.join(root, "Backup"),
    cert: path.join(root, "cert"),
    fiscalXml: path.join(root, "Fiscal", "XML"),
    fiscalPdf: path.join(root, "Fiscal", "PDF"),
    fiscalLogs: path.join(acbr, "logs"),
    fiscalBackup: path.join(acbr, "backup"),
    fiscalIni: path.join(acbr, "ini"),
    fiscalConfig: path.join(acbr, "config"),
    fiscalEntrada: path.join(acbr, "entrada"),
    fiscalSaida: path.join(acbr, "saida"),
    fiscalCancelamentos: path.join(acbr, "cancelamentos"),
    fila: path.join(root, "fila"),
    spool: path.join(root, "spool"),
    impressao: path.join(root, "impressao"),
    temp: path.join(root, "Temp"),
    cache: path.join(root, "Cache"),
    diagnostics: path.join(root, "Diagnostics"),
    agentData: path.join(root, "data"),
    storageRoot: storage,
    produtosOriginal: path.join(produtos, "original"),
    produtosMedium: path.join(produtos, "medium"),
    produtosThumb: path.join(produtos, "thumb"),
    produtosCache: path.join(produtos, "cache"),
    produtosTemp: path.join(produtos, "temp"),
    acbr,
    acbrXml: path.join(acbr, "xml"),
    acbrPdf: path.join(acbr, "pdf"),
  };
}

function mkdirSafe(targetPath) {
  const normalized = path.normalize(String(targetPath || ""));
  if (!normalized) return false;
  try {
    fs.mkdirSync(normalized, { recursive: true });
    return fs.existsSync(normalized);
  } catch {
    try {
      const parent = path.dirname(normalized);
      if (parent && parent !== normalized) {
        fs.mkdirSync(parent, { recursive: true });
        fs.mkdirSync(normalized, { recursive: true });
        return fs.existsSync(normalized);
      }
    } catch {
      /* melhor esforço */
    }
    return false;
  }
}

class DirectoryManager {
  constructor(dataRootOverride) {
    if (dataRootOverride) {
      this.ROOT = path.normalize(dataRootOverride);
      fallbackNote = null;
    } else {
      const resolved = resolveProgramDataRoot();
      this.ROOT = resolved.root;
      fallbackNote = resolved.fallbackFrom;
      mkdirSafe(this.ROOT);
    }

    this.PATHS = buildPaths(this.ROOT);
    this._agentRoot = resolveProgramFilesRoot();
    this._tempRoot = resolveTempRoot();
  }

  get agentRoot() {
    return this._agentRoot;
  }

  get fallbackReason() {
    return fallbackNote;
  }

  dir(key) {
    const p = this.PATHS[key];
    if (!p) return path.join(this.ROOT, String(key));
    return p;
  }

  file(...segments) {
    if (segments.length === 0) return this.ROOT;
    const [logical, ...rest] = segments;
    if (this.PATHS[logical]) {
      return path.join(this.PATHS[logical], ...rest);
    }
    return path.join(this.ROOT, ...segments);
  }

  /**
   * Garante diretório — nunca lança erro (cria ou retorna caminho alvo).
   */
  ensurePath(targetPath, _label) {
    const normalized = path.normalize(String(targetPath || ""));
    if (!normalized) return normalized;
    mkdirSafe(normalized);
    return normalized;
  }

  ensureAll() {
    const seen = new Set();
    mkdirSafe(this.ROOT);
    for (const key of LOGICAL_DIRS) {
      const p = this.PATHS[key];
      if (!p || seen.has(p)) continue;
      seen.add(p);
      this.ensurePath(p, key);
    }
    this.ensurePath(this.PATHS.acbrXml, "acbrXml");
    this.ensurePath(this.PATHS.acbrPdf, "acbrPdf");
    return this.PATHS;
  }

  getDiagnostics() {
    const { getKnownFoldersDiagnostics } = require("./windowsEnv");
    return {
      dataRoot: this.ROOT,
      agentRoot: this._agentRoot,
      tempRoot: this._tempRoot,
      fallbackReason: fallbackNote,
      knownFolders: getKnownFoldersDiagnostics(),
      paths: { ...this.PATHS },
    };
  }
}

function getDirectoryManager(overrideRoot) {
  if (overrideRoot) return new DirectoryManager(overrideRoot);
  if (!singleton) singleton = new DirectoryManager();
  return singleton;
}

function resetDirectoryManager() {
  singleton = null;
  fallbackNote = null;
}

module.exports = {
  DirectoryManager,
  getDirectoryManager,
  resetDirectoryManager,
  LOGICAL_DIRS,
  mkdirSafe,
};
