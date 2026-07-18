/**
 * Guarda de ociosidade antes de aplicar update remoto.
 * Evita restart no meio de emissão fiscal / fila ativa.
 *
 * UPDATE_REQUIRE_IDLE=true (padrão) — bloqueia apply se ocupado.
 * force=true — operador no Diagnóstico confirma e sobrescreve.
 */
const { fiscalEmUso } = require("./print/printFiscalCoordination");

function requireIdleHabilitado(env = process.env) {
  return String(env.UPDATE_REQUIRE_IDLE ?? "true").toLowerCase() !== "false";
}

/**
 * @param {object} [deps] — injetável em testes
 * @returns {string[]}
 */
function coletarBloqueiosUpdate(deps = {}) {
  const bloqueios = [];

  const checkFiscalEmUso = deps.fiscalEmUso ?? fiscalEmUso;
  try {
    if (checkFiscalEmUso()) bloqueios.push("emissão fiscal / ACBr em uso");
  } catch (_) {}

  try {
    const filaFiscal = deps.filaFiscal ?? require("./filaFiscal");
    if (typeof filaFiscal.estaProcessando === "function" && filaFiscal.estaProcessando()) {
      bloqueios.push("fila fiscal processando");
    }
    const st = typeof filaFiscal.status === "function" ? filaFiscal.status() : null;
    const pend = Number(st?.pendentes ?? 0);
    if (pend > 0) bloqueios.push(`fila fiscal com ${pend} pendente(s)`);
  } catch (_) {}

  try {
    const fila = deps.fila ?? require("./fila");
    const contadores =
      typeof fila.contadores === "function"
        ? fila.contadores()
        : typeof fila.metricas === "function"
          ? fila.metricas()
          : typeof fila.status === "function"
            ? fila.status()
            : null;
    const pend = Number(contadores?.pendentes ?? 0);
    if (pend > 0) bloqueios.push(`fila offline com ${pend} venda(s) pendente(s)`);
  } catch (_) {}

  return bloqueios;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.requireIdle] — default via env
 * @param {object} [opts.deps]
 */
function avaliarProntidaoUpdate(opts = {}) {
  const force = opts.force === true;
  const requireIdle =
    opts.requireIdle !== undefined
      ? !!opts.requireIdle
      : requireIdleHabilitado(opts.env || process.env);
  const bloqueios = coletarBloqueiosUpdate(opts.deps);

  if (!requireIdle || force || bloqueios.length === 0) {
    return {
      ok: true,
      bloqueios,
      forçado: force && bloqueios.length > 0,
      requireIdle,
    };
  }

  return {
    ok: false,
    bloqueios,
    forçado: false,
    requireIdle,
    mensagem:
      `Atualização adiada — agente ocupado (${bloqueios.join("; ")}). ` +
      `Aguarde o caixa ocioso ou aplique com confirmação (force).`,
  };
}

module.exports = {
  requireIdleHabilitado,
  coletarBloqueiosUpdate,
  avaliarProntidaoUpdate,
};
