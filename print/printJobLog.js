/**
 * Logs estruturados de impressão — logs/print/YYYY-MM-DD-print.log
 */
const fs = require("fs");
const path = require("path");
const { getDirectoryManager } = require("../runtime/directoryManager");

function dirPrintLogs() {
  const base = getDirectoryManager().dir("logs");
  const d = path.join(base, "print");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function arquivoDoDia(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return path.join(dirPrintLogs(), `${y}-${m}-${d}-print.log`);
}

function registrar(evento) {
  try {
    const linha =
      JSON.stringify({
        ts: new Date().toISOString(),
        ...evento,
      }) + "\n";
    fs.appendFileSync(arquivoDoDia(), linha, "utf8");
  } catch (_) {
    /* fail-safe — log principal via logger */
  }
}

module.exports = { registrar, arquivoDoDia, dirPrintLogs };
