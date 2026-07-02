/**
 * Testes — LoggingService profissional.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data-logging-test");

function rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function readLines(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}:`, e.message);
    process.exitCode = 1;
  }
}

console.log("logging-service.test.js\n");

rmDir(ROOT);
process.env.MARGIN_ENGINE_ROOT = ROOT;
process.env.LOG_SILENT = "false";
process.env.LOG_PATCH_CONSOLE = "false";
process.env.LOG_MODE = "DEBUG";
process.env.LOG_MAX_LINES = "500";

const { resetDirectoryManager } = require("../runtime/directoryManager");
const {
  resetLoggingService,
  getLoggingService,
  initLogging,
  resolveChannel,
} = require("../runtime/loggingService");
const { sanitizeRecord } = require("../runtime/logSanitizer");

resetLoggingService();
resetDirectoryManager();
initLogging({ versao: "1.0.0-test", patchConsole: false });

const svc = getLoggingService();
const fiscalLog = svc.createLogger({ modulo: "fiscal_storage" });
const acbrLog = svc.createLogger({ modulo: "acbr_lib_driver" });
const printerLog = svc.createLogger({ modulo: "printer_service" });

test("sanitizer remove token e senha", () => {
  const clean = sanitizeRecord({
    senha: "123",
    backendToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.x",
    ok: true,
  });
  assert.equal(clean.senha, "[REDACTED]");
  assert.equal(clean.backendToken, "[REDACTED]");
  assert.equal(clean.ok, true);
});

test("resolveChannel por módulo", () => {
  assert.equal(resolveChannel({ modulo: "fiscal_storage" }), "fiscal");
  assert.equal(resolveChannel({ modulo: "acbr_lib_driver" }), "acbr");
  assert.equal(resolveChannel({ modulo: "printer_service" }), "printer");
  assert.equal(resolveChannel({ modulo: "manifest_updater" }), "updater");
});

test("grava em arquivos separados", () => {
  fiscalLog.info({ acao: "emitir" }, "teste fiscal");
  acbrLog.warn("teste acbr");
  printerLog.info("teste printer");

  const logsDir = path.join(ROOT, "Logs");
  assert.ok(fs.existsSync(path.join(logsDir, "fiscal.log")));
  assert.ok(fs.existsSync(path.join(logsDir, "acbr.log")));
  assert.ok(fs.existsSync(path.join(logsDir, "printer.log")));

  const fiscalLine = JSON.parse(readLines(path.join(logsDir, "fiscal.log")).pop());
  assert.equal(fiscalLine.modulo, "fiscal_storage");
  assert.equal(fiscalLine.level, "INFO");
  assert.equal(fiscalLine.versao, "1.0.0-test");
  assert.ok(fiscalLine.timestamp);
  assert.ok(fiscalLine.timezone);
});

test("modo PRODUCTION filtra TRACE", () => {
  resetLoggingService();
  resetDirectoryManager();
  process.env.LOG_MODE = "PRODUCTION";
  initLogging({ versao: "1.0.0", patchConsole: false });
  const prod = getLoggingService().createLogger({ modulo: "agente" });
  prod.trace("nao deve aparecer");
  prod.info("deve aparecer");

  const lines = readLines(path.join(ROOT, "Logs", "application.log"));
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.message, "deve aparecer");
  assert.ok(!lines.some((l) => l.includes("nao deve aparecer")));
  process.env.LOG_MODE = "DEBUG";
});

test("erro extrai stack", () => {
  resetLoggingService();
  resetDirectoryManager();
  initLogging({ patchConsole: false });
  const log = getLoggingService().createLogger({ modulo: "agente" });
  const err = new Error("falha simulada");
  log.error({ err }, "op falhou");
  const lines = readLines(path.join(ROOT, "Logs", "application.log"));
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.erro, "falha simulada");
  assert.ok(last.stack);
});

test("erro enterprise inclui sugestão sem expor stack na API operador", () => {
  resetLoggingService();
  resetDirectoryManager();
  initLogging({ versao: "2.0.0", patchConsole: false });
  const log = getLoggingService().createLogger({ modulo: "fiscal_storage", driver: "acbr-lib" });
  getLoggingService().setStaticContext({
    tenant: "t1",
    empresa: "Loja Teste",
    caixa: "cx-01",
    usuario: "maria",
  });
  log.error(
    { acao: "emitir_nfce", resultado: "falha", tempo: 1200, err: new Error("Certificado A1 expirado") },
    "Emissão rejeitada",
  );
  const lines = readLines(path.join(ROOT, "Logs", "fiscal.log"));
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.tenant, "t1");
  assert.equal(last.empresa, "Loja Teste");
  assert.equal(last.caixa, "cx-01");
  assert.equal(last.usuario, "maria");
  assert.equal(last.driver, "acbr-lib");
  assert.equal(last.acao, "emitir_nfce");
  assert.equal(last.tempo, 1200);
  assert.ok(last.causa);
  assert.ok(last.acaoRecomendada);
  assert.ok(last.sugestao);
  assert.ok(last.stack);

  const { paraOperador } = require("../runtime/logEnterprise");
  const op = paraOperador(last);
  assert.equal(op.stack, undefined);
  assert.ok(op.comoResolver || op.problema);
  assert.ok(!JSON.stringify(op).includes("stack"));
  assert.doesNotMatch(JSON.stringify(op), /acbr-lib|dll/i);
});

test("contexto correlationId via runWithContext", () => {
  const log = getLoggingService().createLogger({ modulo: "fila" });
  getLoggingService().runWithContext({ correlationId: "corr-123", tenant: "t1" }, () => {
    log.info("com contexto");
  });
  const lines = readLines(path.join(ROOT, "Logs", "application.log"));
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.correlationId, "corr-123");
  assert.equal(last.tenant, "t1");
});

rmDir(ROOT);
resetLoggingService();
resetDirectoryManager();
process.env.LOG_SILENT = "true";

console.log("\nConcluído.");
