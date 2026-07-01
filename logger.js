// ============================================================
// PDV Margin Engine — Logger (facade do LoggingService)
//
// Todos os módulos devem usar apenas este arquivo.
// Nunca console.log direto em código de produção.
//
// Uso:
//   const log = require('./logger');
//   const log = require('./logger').child({ modulo: 'fiscal_storage' });
//   log.info('Servidor iniciado');
//   log.error({ err }, 'Falha ao conectar impressora');
//
// Variáveis:
//   LOG_MODE=DEBUG|PRODUCTION
//   LOG_LEVEL=trace|debug|info|warn|error|fatal
//   LOG_MAX_LINES=500 (padrão)
//   LOG_RETENTION_DAYS=30
//   LOG_PATCH_CONSOLE=false (desativa redirecionamento do console)
// ============================================================

const { getLoggingService, initLogging } = require("./runtime/loggingService");

let bootstrapped = false;

function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  let versao = process.env.AGENT_VERSION || null;
  try {
    versao = require("./package.json").version;
  } catch {
    /* ignore */
  }
  initLogging({
    versao,
    patchConsole: process.env.LOG_PATCH_CONSOLE !== "false" && process.env.NODE_ENV !== "test",
  });
}

bootstrap();

module.exports = getLoggingService().getRootLogger();
module.exports.getLoggingService = getLoggingService;
module.exports.initLogging = initLogging;
