// Rate limit global anti-tempestade SEFAZ (janela deslizante + backoff por CNPJ)
const log = require("./logger").child({ modulo: "fiscal_rate_limit" });

const POR_MINUTO = parseInt(process.env.FISCAL_RATE_LIMIT_MIN || "12", 10);
const POR_HORA = parseInt(process.env.FISCAL_RATE_LIMIT_HORA || "200", 10);
const BACKOFF_BASE_MS = parseInt(process.env.FISCAL_RATE_BACKOFF_MS || "60000", 10);

/** @type {Map<string, number[]>} */
const tentativasPorCnpj = new Map();
/** @type {Map<string, number>} bloqueadoAteMs */
const bloqueadoAte = new Map();

function normalizarCnpj(cnpj) {
  return String(cnpj || "default").replace(/\D/g, "").slice(0, 14) || "default";
}

function limparAntigos(arr, janelaMs) {
  const limite = Date.now() - janelaMs;
  while (arr.length && arr[0] < limite) arr.shift();
}

function podeEmitir(cnpj) {
  const key = normalizarCnpj(cnpj);
  const bloqueio = bloqueadoAte.get(key);
  if (bloqueio && Date.now() < bloqueio) {
    const seg = Math.ceil((bloqueio - Date.now()) / 1000);
    return {
      ok: false,
      motivo: `Rate limit/backoff ativo — aguarde ${seg}s antes de nova emissão`,
      aguardarMs: bloqueio - Date.now(),
    };
  }
  if (bloqueio && Date.now() >= bloqueio) bloqueadoAte.delete(key);

  let arr = tentativasPorCnpj.get(key);
  if (!arr) {
    arr = [];
    tentativasPorCnpj.set(key, arr);
  }
  limparAntigos(arr, 60 * 60 * 1000);
  const ultimoMin = arr.filter((t) => t > Date.now() - 60 * 1000).length;
  if (ultimoMin >= POR_MINUTO) {
    return {
      ok: false,
      motivo: `Limite ${POR_MINUTO}/min atingido — proteção anti-tempestade SEFAZ`,
      aguardarMs: 60000,
    };
  }
  if (arr.length >= POR_HORA) {
    return {
      ok: false,
      motivo: `Limite ${POR_HORA}/h atingido — proteção anti-tempestade SEFAZ`,
      aguardarMs: 300000,
    };
  }
  return { ok: true };
}

function registrarTentativa(cnpj) {
  const key = normalizarCnpj(cnpj);
  let arr = tentativasPorCnpj.get(key);
  if (!arr) {
    arr = [];
    tentativasPorCnpj.set(key, arr);
  }
  arr.push(Date.now());
}

function registrarFalha(cnpj, cStat, tentativasJob = 1) {
  const key = normalizarCnpj(cnpj);
  const cs = String(cStat || "");
  let mult = 1;
  if (cs === "999") mult = Math.min(tentativasJob, 5);
  else if (cs.startsWith("5") || cs === "108") mult = 2;
  const ms = BACKOFF_BASE_MS * mult;
  bloqueadoAte.set(key, Date.now() + ms);
  log.warn({ cnpj: key, cStat: cs, backoffMs: ms }, "Backoff rate limit aplicado");
}

function status(cnpj) {
  const key = normalizarCnpj(cnpj);
  const arr = tentativasPorCnpj.get(key) || [];
  const agora = Date.now();
  return {
    porMinuto: arr.filter((t) => t > agora - 60000).length,
    porHora: arr.filter((t) => t > agora - 3600000).length,
    limiteMinuto: POR_MINUTO,
    limiteHora: POR_HORA,
    bloqueadoAte: bloqueadoAte.get(key)
      ? new Date(bloqueadoAte.get(key)).toISOString()
      : null,
  };
}

module.exports = {
  podeEmitir,
  registrarTentativa,
  registrarFalha,
  status,
};
