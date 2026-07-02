/**
 * Testes — leitura de logs enterprise para diagnóstico.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data-log-enterprise");

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

console.log("log-enterprise.test.js\n");

rmDir(ROOT);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.LOG_SILENT = "true";
process.env.LOG_PATCH_CONSOLE = "false";

const { resetDirectoryManager } = require("../runtime/directoryManager");
const { resetLoggingService, initLogging, getLoggingService } = require("../runtime/loggingService");
const { lerUltimosLogsEnterprise, paraOperador } = require("../runtime/logEnterprise");

resetLoggingService();
resetDirectoryManager();
initLogging({ versao: "1.0.0-test", patchConsole: false });

const logsDir = path.join(ROOT, "Logs");
fs.mkdirSync(logsDir, { recursive: true });

const sample = {
  timestamp: "2026-07-01T12:00:00.000Z",
  tenant: "tenant-1",
  empresa: "Padaria Central",
  caixa: "pdv-03",
  usuario: "joao",
  versao: "1.0.0-test",
  driver: "acbr-lib",
  acao: "emitir_nfce",
  tempo: 800,
  resultado: "falha",
  level: "ERROR",
  message: "Emissão rejeitada",
  causa: "Certificado expirado.",
  acaoRecomendada: "Abra Configuração Fiscal → Certificado.",
  sugestao: "Certificado expirado. Ação recomendada: Abra Configuração Fiscal → Certificado.",
  stack: "Error: secret\n    at hidden.js:1:1",
  modulo: "fiscal_storage",
};

fs.writeFileSync(path.join(logsDir, "fiscal.log"), `${JSON.stringify(sample)}\n`, "utf8");

const pack = lerUltimosLogsEnterprise(5);
assert.equal(pack.erros.length, 1);
const entry = pack.erros[0];
assert.ok(entry.problema);
assert.equal(entry.causa, "Certificado expirado.");
assert.ok(entry.comoResolver);

rmDir(ROOT);
resetLoggingService();
resetDirectoryManager();

console.log("  ✓ lerUltimosLogsEnterprise parseia JSON e omite stack");
console.log("\nConcluído.");
