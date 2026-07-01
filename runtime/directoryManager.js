/**
 * DirectoryManager — único ponto de resolução de caminhos do agente.
 *
 * Usa %ProgramData%, %LOCALAPPDATA%, %TEMP% etc. com fallback inteligente.
 * Recria diretórios automaticamente — nunca falha só porque a pasta não existe.
 */
const fs = require("fs");
const path = require("path");
const { RuntimeError, mapFsError } = require("./runtimeErrors");
const {
  resolveProgramDataRoot,
  resolveProgramFilesRoot,
  resolveTempRoot,
  isWritableDir,
} = require("./windowsEnv");

const LOGICAL_DIRS = [
  "logs",
  "config",
  "backup",
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

class DirectoryManager {
  constructor(dataRootOverride) {
    if (dataRootOverride) {
      this.ROOT = path.normalize(dataRootOverride);
      fallbackNote = null;
    } else {
      const resolved = resolveProgramDataRoot();
      this.ROOT = resolved.root;
      fallbackNote = resolved.fallbackFrom;
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
    if (!p) throw new RuntimeError("DIR-003", { motivo: `Diretório lógico desconhecido: ${key}` });
    return p;
  }

  file(...segments) {
    if (segments.length === 0) throw new RuntimeError("DIR-003", { motivo: "file() requer segmentos" });
    const [logical, ...rest] = segments;
    if (this.PATHS[logical]) {
      return path.join(this.PATHS[logical], ...rest);
    }
    return path.join(this.ROOT, ...segments);
  }

  ensurePath(targetPath, label) {
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      return targetPath;
    } catch (err) {
      throw mapFsError(err, {
        diretorio: targetPath,
        operacao: `criar diretório (${label || "runtime"})`,
      });
    }
  }

  ensureAll() {
    const seen = new Set();
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
    return {
      dataRoot: this.ROOT,
      agentRoot: this._agentRoot,
      tempRoot: this._tempRoot,
      fallbackReason: fallbackNote,
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
};
