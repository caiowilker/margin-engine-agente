/**
 * Rate limit para mint/exchange do QR Garçom (rede do salão).
 * Loopback não limita (painel do caixa no mesmo PC).
 */
const log = require("./logger").child({ modulo: "garcom_floor_rate_limit" });

const POR_MINUTO = parseInt(process.env.GARCOM_FLOOR_RATE_LIMIT_MIN || "30", 10);

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
      log.warn({ ip: key, limite: POR_MINUTO }, "Rate limit floor garçom excedido");
      return res.status(429).json({
        erro: `Limite de ${POR_MINUTO} tentativas/min no QR do salão — aguarde e tente novamente`,
      });
    }
    arr.push(Date.now());
    next();
  };
}

module.exports = { middleware, POR_MINUTO };
