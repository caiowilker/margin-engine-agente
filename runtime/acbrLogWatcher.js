/**
 * Monitora logs da ACBrLib (escrita nativa, fora do LoggingService).
 * Aplica LOG_MAX_LINES / LOG_MAX_SIZE_MB via checkAndRotateLog.
 */
const fs = require("fs");
const path = require("path");
const {
  checkAndRotateLog,
  getOrCreateState,
  resetLogRotationState,
} = require("./logRotation");

const watchedDirs = new Set();
let timer = null;

function registerAcbrLogDir(dirPath) {
  if (!dirPath) return;
  const normalized = path.normalize(dirPath);
  watchedDirs.add(normalized);
  ensureWatcher();
}

function ensureWatcher() {
  if (timer || watchedDirs.size === 0) return;
  const ms = parseInt(process.env.ACBR_LOG_WATCH_MS || "30000", 10);
  const interval = Number.isFinite(ms) && ms > 0 ? ms : 30000;
  timer = setInterval(() => {
    tickAcbrLogs().catch(() => {});
  }, interval);
  if (typeof timer.unref === "function") timer.unref();
}

function stopAcbrLogWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tickAcbrLogs() {
  for (const dir of watchedDirs) {
    if (!fs.existsSync(dir)) continue;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const low = name.toLowerCase();
      if (!low.endsWith(".log")) continue;
      if (/\.\d+\.log$/.test(low)) continue;
      const fp = path.join(dir, name);
      const state = getOrCreateState(fp);
      checkAndRotateLog(fp, state, { syncFromDisk: true });
    }
  }
}

module.exports = {
  registerAcbrLogDir,
  tickAcbrLogs,
  stopAcbrLogWatcher,
  resetLogRotationState,
};
