// ============================================================
// PDV Margin Engine — Logger v1.0
//
// Usa pino para logs estruturados (JSON em producao).
// Em desenvolvimento (NODE_ENV != production) formata bonito
// no terminal com pino-pretty (se instalado), senao usa JSON.
//
// Rotacao automatica: novo arquivo a cada 10 MB ou 1 dia,
// mantendo os ultimos 7 arquivos. Logs ficam em data/logs/.
//
// Uso:
//   const log = require('./logger');
//   log.info('Servidor iniciado na porta %d', 9100);
//   log.error({ err }, 'Falha ao conectar impressora');
//   log.warn({ modulo: 'fila', pendentes: 5 }, 'Fila acumulando');
// ============================================================

const pino = require("pino");
const path = require("path");
const fs = require("fs");

const LOG_DIR = path.join(__dirname, "data", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isProd = process.env.NODE_ENV === "production";

let transport;

if (isProd) {
  // Producao: JSON para arquivo com rotacao (pino-roll)
  // pino-roll aceita: size (bytes), limit.count (arquivos retidos)
  try {
    transport = pino.transport({
      targets: [
        {
          // Console simplificado (erros visiveis no log do servico Windows)
          target: "pino/file",
          options: { destination: 1 }, // stdout
          level: "warn",
        },
        {
          // Arquivo rotativo
          target: "pino-roll",
          options: {
            file: path.join(LOG_DIR, "agente.log"),
            frequency: "daily",
            size: "10m",
            limit: { count: 7 },
          },
          level: "info",
        },
      ],
    });
  } catch (_) {
    // Fallback se pino-roll nao estiver disponivel ainda
    transport = pino.transport({
      target: "pino/file",
      options: { destination: path.join(LOG_DIR, "agente.log") },
    });
  }
} else {
  // Desenvolvimento: tenta pino-pretty, senao JSON colorido no terminal
  try {
    require.resolve("pino-pretty");
    transport = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    });
  } catch (_) {
    transport = undefined; // usa stdout JSON padrao
  }
}

const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
    base: { pid: false, hostname: false },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  transport,
);

module.exports = logger;
