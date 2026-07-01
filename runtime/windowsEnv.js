/**
 * Resolução de diretórios Windows via variáveis oficiais — sem caminhos fixos.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function envPath(name) {
  const v = process.env[name];
  return v && String(v).trim() ? path.normalize(String(v).trim()) : null;
}

function resolveProgramDataRoot() {
  if (process.env.MARGIN_ENGINE_ROOT) {
    return {
      root: path.normalize(process.env.MARGIN_ENGINE_ROOT),
      fallbackFrom: null,
    };
  }

  const fromEnv = envPath("PROGRAMDATA") || envPath("ProgramData");
  const candidates = [
    fromEnv ? path.join(fromEnv, "MarginEngine") : null,
    fromEnv ? path.join(fromEnv, "Margin Engine") : null,
    envPath("LOCALAPPDATA")
      ? path.join(envPath("LOCALAPPDATA"), "MarginEngine")
      : null,
    path.join(os.homedir(), ".margin-engine"),
    path.join(os.tmpdir(), "margin-engine-data"),
  ];

  const chosen =
    firstWritable(candidates) || path.normalize(candidates[candidates.length - 1]);

  return { root: chosen, fallbackFrom: fromEnv ? null : "LOCALAPPDATA" };
}

function resolveProgramFilesRoot() {
  const agentRoot = process.env.MARGIN_ENGINE_AGENT_ROOT;
  if (agentRoot) return path.normalize(agentRoot);

  const pf =
    envPath("ProgramFiles") ||
    envPath("PROGRAMFILES") ||
    envPath("ProgramFiles(x86)") ||
    envPath("PROGRAMFILES(X86)");

  return pf ? path.join(pf, "Margin Engine") : path.join(__dirname, "..");
}

function resolveTempRoot() {
  return (
    envPath("TEMP") ||
    envPath("TMP") ||
    envPath("LOCALAPPDATA") ||
    os.tmpdir()
  );
}

function resolveStagingDir(name) {
  return path.join(resolveTempRoot(), name);
}

module.exports = {
  isWritableDir,
  resolveProgramDataRoot,
  resolveProgramFilesRoot,
  resolveTempRoot,
  resolveStagingDir,
  envPath,
};
