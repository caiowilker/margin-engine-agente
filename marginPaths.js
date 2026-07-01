// MarginEngine — estrutura de diretórios (delegado ao DirectoryManager)
const { getDirectoryManager } = require("./runtime/directoryManager");

function getDm() {
  return getDirectoryManager();
}

function ensureDirs() {
  return getDm().ensureAll();
}

function getPaths() {
  const dm = getDm();
  const p = dm.PATHS;
  return {
    root: p.root,
    data: p.agentData,
    acbr: p.acbr,
    entrada: p.fiscalEntrada,
    saida: p.fiscalSaida,
    ini: p.fiscalIni,
    xml: p.acbrXml,
    pdf: p.acbrPdf,
    logs: p.fiscalLogs,
    backup: p.fiscalBackup,
    cancelamentos: p.fiscalCancelamentos,
    inutilizacoes: p.acbrXml,
    fila: p.fila,
    spool: p.spool,
    impressao: p.impressao,
    temp: p.temp,
  };
}

const dm = getDm();
const PATHS = getPaths();
const ROOT = dm.ROOT;

module.exports = {
  PATHS,
  ensureDirs,
  ROOT,
  getPaths,
  getDirectoryManager: getDm,
};
