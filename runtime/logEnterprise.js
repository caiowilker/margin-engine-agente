/**
 * Leitura e formatação de logs enterprise para suporte e UI do operador.
 * Stack permanece somente nos arquivos — nunca na resposta para o operador.
 */
const fs = require("fs");
const path = require("path");

const ARQUIVOS_LOG = [
  "application.log",
  "fiscal.log",
  "acbr.log",
  "printer.log",
  "updater.log",
  "installer.log",
];

const CAMPOS_ENTERPRISE = [
  "timestamp",
  "tenant",
  "empresa",
  "caixa",
  "usuario",
  "versao",
  "driver",
  "acao",
  "tempo",
  "resultado",
  "causa",
  "sugestao",
  "acaoRecomendada",
  "message",
  "modulo",
  "level",
  "correlationId",
];

function parseLinhaLog(line) {
  if (!line || typeof line !== "string") return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function montarSugestao(record) {
  if (record.sugestao) return record.sugestao;
  if (record.causa && record.acaoRecomendada) {
    return `${record.causa} Ação recomendada: ${record.acaoRecomendada}`;
  }
  return record.acaoRecomendada || record.causa || null;
}

/** Entrada completa para suporte (inclui stack nos arquivos; API pode omitir). */
function normalizarEntrada(record, arquivo) {
  if (!record || typeof record !== "object") return null;
  const level = String(record.level || "").toUpperCase();
  return {
    timestamp: record.timestamp || null,
    tenant: record.tenant ?? null,
    empresa: record.empresa ?? null,
    caixa: record.caixa ?? null,
    usuario: record.usuario ?? null,
    versao: record.versao ?? null,
    driver: record.driver ?? null,
    acao: record.acao ?? null,
    tempo: record.tempo ?? record.durationMs ?? null,
    resultado: record.resultado ?? null,
    causa: record.causa ?? record.erro ?? null,
    sugestao: montarSugestao(record),
    acaoRecomendada: record.acaoRecomendada ?? null,
    message: record.message ?? null,
    modulo: record.modulo ?? null,
    level,
    correlationId: record.correlationId ?? null,
    arquivo: arquivo || null,
    stack: record.stack ?? null,
    erro: record.erro ?? null,
  };
}

/** Versão segura para operador — sem stack, paths nem termos técnicos. */
function paraOperador(entry) {
  if (!entry) return null;
  const { paraOperador: po, contemTermoTecnico: tecnico } = require("./mensagensOperador");
  const raw = entry.causa || entry.message || entry.erro || "";
  const op = tecnico(raw) ? po({ message: raw }) : po({ message: raw });
  const out = {
    timestamp: entry.timestamp || null,
    problema: op.problema,
    causa: entry.causa && !tecnico(entry.causa) ? entry.causa : op.causa,
    comoResolver: entry.acaoRecomendada || entry.sugestao || op.comoResolver,
    acao: entry.acao ?? null,
    resultado: entry.resultado ?? null,
    level: entry.level,
  };
  if (!out.causa) out.causa = op.causa;
  if (!out.comoResolver) out.comoResolver = op.comoResolver;
  return out;
}

function nivelEhErro(level) {
  const l = String(level || "").toUpperCase();
  return l === "ERROR" || l === "FATAL";
}

function nivelEhAviso(level) {
  return String(level || "").toUpperCase() === "WARN";
}

function sanitizarPathLog(p) {
  const { sanitizePathForDisplay } = require("./windowsEnv");
  return sanitizePathForDisplay(p);
}

function lerUltimosLogsEnterprise(limit = 20, options = {}) {
  const { incluirStack = false } = options;
  try {
    const { getDirectoryManager } = require("./directoryManager");
    const logsDir = getDirectoryManager().PATHS.logs;
    const coletados = [];

    for (const file of ARQUIVOS_LOG) {
      const full = path.join(logsDir, file);
      if (!fs.existsSync(full)) continue;
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-300)) {
        const parsed = parseLinhaLog(line);
        if (!parsed) continue;
        const level = String(parsed.level || "").toUpperCase();
        if (!nivelEhErro(level) && !nivelEhAviso(level)) continue;
        const norm = normalizarEntrada(parsed, file);
        if (!norm) continue;
        coletados.push(norm);
      }
    }

    coletados.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    const erros = [];
    const avisos = [];
    for (const item of coletados) {
      const operador = paraOperador(item);
      if (incluirStack && item.stack) {
        operador._stackArquivo = true;
      }
      if (nivelEhErro(item.level)) {
        if (erros.length < limit) erros.push(operador);
      } else if (avisos.length < limit) {
        avisos.push(operador);
      }
      if (erros.length >= limit && avisos.length >= limit) break;
    }

    return {
      erros,
      avisos,
      pastaLogs: sanitizarPathLog(logsDir),
      pastaLogsReal: logsDir,
    };
  } catch {
    return { erros: [], avisos: [], pastaLogs: null, pastaLogsReal: null };
  }
}

module.exports = {
  ARQUIVOS_LOG,
  parseLinhaLog,
  normalizarEntrada,
  paraOperador,
  montarSugestao,
  lerUltimosLogsEnterprise,
};
