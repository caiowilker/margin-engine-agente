/**
 * Rotação, compressão e limpeza de arquivos de log.
 * Padrão: máximo 500 linhas por arquivo (LOG_MAX_LINES).
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const stateByPath = new Map();

const DEFAULT_MAX_LINES = parseInt(process.env.LOG_MAX_LINES || "500", 10);
const DEFAULT_MAX_BYTES = parseInt(process.env.LOG_MAX_SIZE_MB || "5", 10) * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "30", 10);
const DEFAULT_RETENTION_FILES = parseInt(process.env.LOG_RETENTION_FILES || "14", 10);
const COMPRESS = process.env.LOG_COMPRESS !== "false";

function getOrCreateState(filePath) {
  if (!stateByPath.has(filePath)) {
    stateByPath.set(filePath, { lastSize: 0, lastLineCount: 0 });
  }
  return stateByPath.get(filePath);
}

function resetLogRotationState() {
  stateByPath.clear();
}

function countLines(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf.length && buf[buf.length - 1] !== 10) n++;
  return n;
}

function rotate(filePath, state) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ".log");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = path.join(dir, `${base}.${stamp}.log`);

  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, rotated);
      if (COMPRESS) {
        const gz = `${rotated}.gz`;
        const data = fs.readFileSync(rotated);
        fs.writeFileSync(gz, zlib.gzipSync(data));
        fs.unlinkSync(rotated);
      }
    }
    fs.writeFileSync(filePath, "");
    state.lastSize = 0;
    state.lastLineCount = 0;
    purgeOldLogs(dir, base);
    return true;
  } catch {
    return false;
  }
}

function purgeOldLogs(dir, baseName) {
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  const maxAge = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pattern = new RegExp(`^${baseName}(\\.\\d{4}|\\.[0-9T-]+)?\\.log(\\.gz)?$`);

  const candidates = fs
    .readdirSync(dir)
    .filter((n) => pattern.test(n) && n !== `${baseName}.log`)
    .map((n) => {
      const fp = path.join(dir, n);
      try {
        const st = fs.statSync(fp);
        return { fp, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  for (let i = DEFAULT_RETENTION_FILES; i < candidates.length; i++) {
    try {
      fs.unlinkSync(candidates[i].fp);
    } catch {
      /* ignore */
    }
  }

  for (const c of candidates) {
    if (now - c.mtime > maxAge) {
      try {
        fs.unlinkSync(c.fp);
      } catch {
        /* ignore */
      }
    }
  }
}

function checkAndRotateLog(filePath, state, options = {}) {
  if (!fs.existsSync(filePath)) return false;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  const stat = fs.statSync(filePath);
  if (options.syncFromDisk) {
    state.lastSize = stat.size;
  }

  if (stat.size > maxBytes) {
    return rotate(filePath, state);
  }

  if (options.checkLines !== false) {
    const sample = fs.readFileSync(filePath);
    if (countLines(sample) > maxLines) {
      return rotate(filePath, state);
    }
  }

  return false;
}

function afterAppend(filePath, state, options = {}) {
  try {
    const stat = fs.statSync(filePath);
    state.lastSize = stat.size;
    checkAndRotateLog(filePath, state, options);
  } catch {
    /* disco indisponível */
  }
}

module.exports = {
  checkAndRotateLog,
  afterAppend,
  getOrCreateState,
  resetLogRotationState,
  countLines,
  DEFAULT_MAX_LINES,
};
