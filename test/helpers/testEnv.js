/**
 * Utilitários compartilhados para testes — diretórios temporários e limpeza.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_ROOT = path.join(__dirname, "..");

function rmDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Remove pastas test/data-* e variantes com sufixo de pid. */
function cleanProjectTestDataDirs(rootDir = TEST_ROOT) {
  if (!fs.existsSync(rootDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(rootDir)) {
    if (!/^data-/.test(name)) continue;
    rmDir(path.join(rootDir, name));
    removed += 1;
  }
  const tmpPrefix = path.join(os.tmpdir(), "margin-engine-");
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith("margin-engine-")) continue;
      rmDir(path.join(os.tmpdir(), name));
      removed += 1;
    }
  } catch {
    /* tmp inacessível — ignorar */
  }
  return removed;
}

/** Diretório temporário fora do repositório (limpo pelo SO; também removido no teardown). */
function mkTestTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `margin-engine-${prefix}-`));
}

function disableConsoleLogPatching() {
  process.env.LOG_PATCH_CONSOLE = "false";
}

function resetRuntimeForEnv(overrides = {}) {
  const { resetDirectoryManager } = require("../../runtime/directoryManager");
  const { resetLoggingService } = require("../../runtime/loggingService");
  const { resetLogRotationState } = require("../../runtime/logRotation");
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  resetLoggingService();
  resetDirectoryManager();
  resetLogRotationState();
}

function withSavedEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] == null) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  resetRuntimeForEnv();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetRuntimeForEnv();
  }
}

module.exports = {
  TEST_ROOT,
  rmDir,
  cleanProjectTestDataDirs,
  mkTestTemp,
  disableConsoleLogPatching,
  resetRuntimeForEnv,
  withSavedEnv,
};
