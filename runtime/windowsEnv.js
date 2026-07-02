/**
 * Resolução de diretórios Windows via APIs oficiais (.NET SpecialFolder / variáveis do SO).
 * Nunca usa caminhos fixos como C:\ProgramData.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const knownFolderCache = new Map();

const SPECIAL_FOLDER_ENV = {
  CommonApplicationData: ["PROGRAMDATA", "ProgramData"],
  LocalApplicationData: ["LOCALAPPDATA", "LocalAppData"],
  ProgramFiles: ["ProgramFiles", "PROGRAMFILES"],
  ProgramFilesX86: ["ProgramFiles(x86)", "PROGRAMFILES(X86)"],
  CommonProgramFiles: ["CommonProgramFiles", "COMMONPROGRAMFILES"],
  UserProfile: ["USERPROFILE", "UserProfile"],
};

const DISPLAY_ALIASES = {
  CommonApplicationData: "%ProgramData%",
  LocalApplicationData: "%LocalAppData%",
  ProgramFiles: "%ProgramFiles%",
  ProgramFilesX86: "%ProgramFiles(x86)%",
  UserProfile: "%UserProfile%",
};

function envPath(name) {
  const v = process.env[name];
  return v && String(v).trim() ? path.normalize(String(v).trim()) : null;
}

function isWritableDir(dir) {
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.margin-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function firstWritable(candidates) {
  for (const c of candidates) {
    if (c && isWritableDir(c)) return path.normalize(c);
  }
  return null;
}

/**
 * Resolve pasta conhecida do Windows via [Environment]::GetFolderPath (SHGetKnownFolderPath).
 * Fallback: variáveis de ambiente oficiais do processo.
 */
function getWindowsKnownFolder(specialFolder) {
  if (knownFolderCache.has(specialFolder)) {
    return knownFolderCache.get(specialFolder);
  }

  let resolved = null;

  if (process.platform === "win32") {
    try {
      const script = `[Environment]::GetFolderPath([Environment+SpecialFolder]::${
        specialFolder === "ProgramFilesX86" ? "ProgramFilesX86" : specialFolder
      })`;
      const out = execSync(`powershell -NoProfile -Command "${script}"`, {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) resolved = path.normalize(out);
    } catch {
      /* tenta env */
    }
  }

  if (!resolved) {
    for (const envName of SPECIAL_FOLDER_ENV[specialFolder] || []) {
      const v = envPath(envName);
      if (v) {
        resolved = v;
        break;
      }
    }
  }

  knownFolderCache.set(specialFolder, resolved || null);
  return resolved;
}

function resolveCommonAppDataRoot() {
  return (
    getWindowsKnownFolder("CommonApplicationData") ||
    envPath("PROGRAMDATA") ||
    envPath("ProgramData") ||
    null
  );
}

function resolveLocalAppDataRoot() {
  return (
    getWindowsKnownFolder("LocalApplicationData") ||
    envPath("LOCALAPPDATA") ||
    envPath("LocalAppData") ||
    null
  );
}

function resolveProgramDataRoot() {
  if (process.env.MARGIN_ENGINE_ROOT) {
    return {
      root: path.normalize(process.env.MARGIN_ENGINE_ROOT),
      fallbackFrom: null,
    };
  }

  const commonAppData = resolveCommonAppDataRoot();
  const localAppData = resolveLocalAppDataRoot();

  const candidates = [
    commonAppData ? path.join(commonAppData, "MarginEngine") : null,
    commonAppData ? path.join(commonAppData, "Margin Engine") : null,
    localAppData ? path.join(localAppData, "MarginEngine") : null,
    path.join(os.homedir(), ".margin-engine"),
    path.join(os.tmpdir(), "margin-engine-data"),
  ];

  const chosen =
    firstWritable(candidates) ||
    path.normalize(candidates.find(Boolean) || path.join(os.tmpdir(), "margin-engine-data"));

  let fallbackFrom = null;
  if (!commonAppData) fallbackFrom = localAppData ? "LocalApplicationData" : "homedir";

  return { root: chosen, fallbackFrom };
}

function resolveProgramFilesRoot() {
  const agentRoot = process.env.MARGIN_ENGINE_AGENT_ROOT;
  if (agentRoot) return path.normalize(agentRoot);

  const pf =
    getWindowsKnownFolder("ProgramFiles") ||
    envPath("ProgramFiles") ||
    envPath("PROGRAMFILES");

  return pf ? path.join(pf, "Margin Engine") : path.join(__dirname, "..");
}

function resolveTempRoot() {
  return (
    envPath("TEMP") ||
    envPath("TMP") ||
    resolveLocalAppDataRoot() ||
    os.tmpdir()
  );
}

function resolveStagingDir(name) {
  return path.join(resolveTempRoot(), name);
}

/** Substitui raízes conhecidas por aliases (%ProgramData%, etc.) — sem literais C:\ */
function sanitizePathForDisplay(inputPath) {
  if (!inputPath) return "—";
  let p = String(inputPath);
  for (const [folder, alias] of Object.entries(DISPLAY_ALIASES)) {
    const root = getWindowsKnownFolder(folder);
    if (!root) continue;
    const normRoot = root.replace(/\\/g, "\\\\");
    const re = new RegExp(`^${normRoot}`, "i");
    if (re.test(p)) {
      p = alias + p.slice(root.length);
      break;
    }
  }
  return p
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "%UserProfile%")
    .replace(/\/home\/[^/]+/i, "~");
}

function getKnownFoldersDiagnostics() {
  return {
    CommonApplicationData: resolveCommonAppDataRoot(),
    LocalApplicationData: resolveLocalAppDataRoot(),
    ProgramFiles: getWindowsKnownFolder("ProgramFiles"),
    ProgramFilesX86: getWindowsKnownFolder("ProgramFilesX86"),
    Temp: resolveTempRoot(),
  };
}

module.exports = {
  isWritableDir,
  getWindowsKnownFolder,
  resolveCommonAppDataRoot,
  resolveLocalAppDataRoot,
  resolveProgramDataRoot,
  resolveProgramFilesRoot,
  resolveTempRoot,
  resolveStagingDir,
  sanitizePathForDisplay,
  getKnownFoldersDiagnostics,
  envPath,
  DISPLAY_ALIASES,
};
