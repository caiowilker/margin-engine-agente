// MarginEngine — estrutura de diretórios fiscal (armazenamento)
const path = require("path");
const fs = require("fs");

const ROOT =
  process.env.MARGIN_ENGINE_ROOT ||
  path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "MarginEngine");

const PATHS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  acbr: path.join(ROOT, "acbr"),
  entrada: path.join(ROOT, "acbr", "entrada"),
  saida: path.join(ROOT, "acbr", "saida"),
  ini: path.join(ROOT, "acbr", "ini"),
  xml: path.join(ROOT, "acbr", "xml"),
  pdf: path.join(ROOT, "acbr", "pdf"),
  logs: path.join(ROOT, "acbr", "logs"),
  backup: path.join(ROOT, "acbr", "backup"),
  cancelamentos: path.join(ROOT, "acbr", "cancelamentos"),
  inutilizacoes: path.join(ROOT, "acbr", "xml"),
  fila: path.join(ROOT, "fila"),
  spool: path.join(ROOT, "spool"),
  impressao: path.join(ROOT, "impressao"),
  temp: path.join(ROOT, "temp"),
};

function ensureDirs() {
  Object.values(PATHS).forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

module.exports = { PATHS, ensureDirs, ROOT };
