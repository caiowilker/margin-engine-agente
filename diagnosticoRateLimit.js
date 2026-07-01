// Rate limit separado para endpoints de diagnóstico (recovery, relatório)
const log = require("./logger").child({ modulo: "diagnostico_rate_limit" });

const POR_MINUTO = parseInt(process.env.DIAGNOSTICO_RATE_LIMIT_MIN || "10", 10);

/** @type {Map<string, number[]>} */
const tentativasPorIp = new Map();

function chaveIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function limparAntigos(arr, janelaMs) {
  const limite = Date.now() - janelaMs;
  while (arr.length && arr[0] < limite) arr.shift();
}

function middleware() {
  return (req, res, next) => {
    const key = chaveIp(req);
    const ipNorm = String(key).replace(/^::ffff:/, "");
    // Mesmo computador (browser + agente) — não limitar recovery automático do painel
    if (ipNorm === "127.0.0.1" || ipNorm === "::1") {
      return next();
    }
    let arr = tentativasPorIp.get(key);
    if (!arr) {
      arr = [];
      tentativasPorIp.set(key, arr);
    }
    limparAntigos(arr, 60 * 1000);
    if (arr.length >= POR_MINUTO) {
      log.warn({ ip: key, limite: POR_MINUTO }, "Rate limit diagnóstico excedido");
      return res.status(429).json({
        erro: `Limite de ${POR_MINUTO} requisições/min para diagnóstico — aguarde e tente novamente`,
      });
    }
    arr.push(Date.now());
    next();
  };
}

module.exports = { middleware, POR_MINUTO };
