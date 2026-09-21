"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Mantém apenas os N diretórios de lote mais recentes em pasta de auditoria/sombra.
 */
function aplicarRetencaoSnapshots(pastaAudit, retencao) {
  const n = Math.max(1, Math.min(50, Number(retencao) || 5));
  if (!pastaAudit || !fs.existsSync(pastaAudit)) return 0;
  const dirs = fs
    .readdirSync(pastaAudit, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(pastaAudit, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  let removidos = 0;
  for (let i = n; i < dirs.length; i++) {
    try {
      fs.rmSync(dirs[i].full, { recursive: true, force: true });
      removidos++;
    } catch {
      /* ignore */
    }
  }
  return removidos;
}

module.exports = { aplicarRetencaoSnapshots };
