/**
 * Rastro fiscal em memória + arquivo — últimas N linhas (padrão 500).
 * Complementa pino/ACBrLib para diagnóstico no painel :9100/diagnostico/painel#logs
 */
const fs = require("fs");
const path = require("path");
const { PATHS, ensureDirs } = require("./marginPaths");
const { resolveStagingDir } = require("./runtime/windowsEnv");

const MAX_LINES = Math.min(
  2000,
  Math.max(50, parseInt(process.env.FISCAL_TRACE_MAX_LINES || "500", 10) || 500),
);

const buffer = [];
const TRACE_FILE = path.join(PATHS.logs, "fiscal-trace.log");

function hydrateBufferFromFile() {
  try {
    if (!fs.existsSync(TRACE_FILE)) return;
    const lines = fs.readFileSync(TRACE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-MAX_LINES)) {
      buffer.push(line);
    }
  } catch {
    /* ignore */
  }
}

hydrateBufferFromFile();

function isoNow() {
  return new Date().toISOString();
}

function formatLine(level, tag, message, meta) {
  const metaStr =
    meta && Object.keys(meta).length
      ? " " + JSON.stringify(meta, (_, v) => (typeof v === "string" && v.length > 400 ? v.slice(0, 400) + "…" : v))
      : "";
  return `${isoNow()} [${level}] [${tag}] ${message}${metaStr}`;
}

function trimBuffer() {
  while (buffer.length > MAX_LINES) buffer.shift();
}

function trimFile() {
  try {
    if (!fs.existsSync(TRACE_FILE)) return;
    const raw = fs.readFileSync(TRACE_FILE, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(TRACE_FILE, lines.slice(-MAX_LINES).join("\n") + "\n", "utf8");
  } catch {
    /* disco indisponível */
  }
}

function append(level, tag, message, meta) {
  const line = formatLine(level, tag, message, meta);
  buffer.push(line);
  trimBuffer();
  try {
    ensureDirs();
    fs.appendFileSync(TRACE_FILE, line + "\n", "utf8");
    if (buffer.length % 25 === 0) trimFile();
  } catch {
    /* ignore */
  }
  return line;
}

function trace(tag, message, meta) {
  return append("INFO", tag, message, meta);
}

function warn(tag, message, meta) {
  return append("WARN", tag, message, meta);
}

function error(tag, message, meta) {
  return append("ERROR", tag, message, meta);
}

function tail(n) {
  const limit = Math.min(MAX_LINES, Math.max(1, parseInt(n, 10) || MAX_LINES));
  return buffer.slice(-limit);
}

function readFileTail(filePath, n) {
  const limit = Math.min(MAX_LINES, Math.max(1, parseInt(n, 10) || MAX_LINES));
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

/** Lê logs ACBrLib em ProgramData e staging (%TEMP%/margin-acbrlib/log). */
function tailAcbrLib(n) {
  const limit = Math.min(MAX_LINES, Math.max(1, parseInt(n, 10) || MAX_LINES));
  const candidates = [];

  const logsDir = PATHS.logs;
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      const low = f.toLowerCase();
      if (low.endsWith(".log") && f !== "fiscal-trace.log") {
        candidates.push(path.join(logsDir, f));
      }
    }
  }

  const stagingLog = path.join(
    process.env.ACBR_WIN_STAGING || resolveStagingDir("margin-acbrlib"),
    "log",
  );
  if (fs.existsSync(stagingLog)) {
    for (const f of fs.readdirSync(stagingLog)) {
      if (f.toLowerCase().endsWith(".log")) {
        candidates.push(path.join(stagingLog, f));
      }
    }
  }

  const merged = [];
  const filesUsed = [];
  for (const fp of candidates) {
    try {
      const st = fs.statSync(fp);
      filesUsed.push({ path: fp, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* skip */
    }
  }
  filesUsed.sort((a, b) => b.mtime - a.mtime);

  for (const { path: fp } of filesUsed.slice(0, 5)) {
    const lines = readFileTail(fp, limit);
    if (lines.length) {
      merged.push(`--- ${fp} ---`);
      merged.push(...lines);
    }
    if (merged.length >= limit) break;
  }

  return {
    lines: merged.slice(-limit),
    files: filesUsed.map((f) => f.path),
  };
}

/** Copia o log ACBr mais recente do staging para ProgramData (pós-emissão). */
function copiarLogAcbrStagingParaCanonico(runtime) {
  if (!runtime?.log || !fs.existsSync(runtime.log)) return null;
  try {
    ensureDirs();
    const recent = fs
      .readdirSync(runtime.log)
      .filter((f) => f.toLowerCase().endsWith(".log"))
      .map((f) => ({ f, m: fs.statSync(path.join(runtime.log, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!recent) return null;
    const src = path.join(runtime.log, recent.f);
    const dest = path.join(PATHS.logs, `acbr-${recent.f}`);
    fs.copyFileSync(src, dest);
    trace("ACBrLog", "Log ACBr copiado do staging", { de: src, para: dest });
    return dest;
  } catch (err) {
    warn("ACBrLog", "Falha ao copiar log ACBr do staging", { err: err.message });
    return null;
  }
}

function snapshot(n) {
  const limit = Math.min(MAX_LINES, Math.max(1, parseInt(n, 10) || MAX_LINES));
  const traceLines = tail(limit);
  const acbr = tailAcbrLib(Math.max(0, limit - traceLines.length));
  const combined = [...traceLines, ...acbr.lines].slice(-limit);
  return {
    limit,
    maxLines: MAX_LINES,
    total: combined.length,
    lines: combined,
    sources: {
      trace: traceLines.length,
      acbr: acbr.lines.length,
      traceFile: TRACE_FILE,
      acbrFiles: acbr.files,
    },
  };
}

module.exports = {
  MAX_LINES,
  trace,
  warn,
  error,
  tail,
  tailAcbrLib,
  snapshot,
  copiarLogAcbrStagingParaCanonico,
};
