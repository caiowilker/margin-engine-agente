/**
 * Regras puras de contingência EPEC — quando entrar/sair automaticamente.
 * Sem I/O: fácil de testar e estável.
 */

/**
 * @param {{
 *   ativa: boolean,
 *   epecPendentes: number,
 *   sefazOk: boolean,
 *   force?: boolean,
 * }} input
 * @returns {{ podeEncerrar: boolean, motivo: string }}
 */
function decidirEncerrarAutomatico(input) {
  const ativa = input?.ativa === true;
  const force = input?.force === true;
  const pendentes = Math.max(0, Number(input?.epecPendentes) || 0);
  const sefazOk = input?.sefazOk === true;

  if (!ativa) {
    return { podeEncerrar: false, motivo: "contingencia_inativa" };
  }
  if (force) {
    return { podeEncerrar: true, motivo: "force_operador" };
  }
  if (!sefazOk) {
    return { podeEncerrar: false, motivo: "sefaz_indisponivel" };
  }
  if (pendentes > 0) {
    return { podeEncerrar: false, motivo: "epec_pendentes", pendentes };
  }
  return { podeEncerrar: true, motivo: "sefaz_ok_sem_pendentes" };
}

/**
 * Contagem efetiva de pendentes que bloqueiam auto-exit.
 * FALHA_PERMANENTE não bloqueia (exige ação humana, não prende o modo).
 */
function contarPendentesBloqueantes(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.filter((r) => String(r?.status || "PENDENTE").toUpperCase() === "PENDENTE")
    .length;
}

module.exports = {
  decidirEncerrarAutomatico,
  contarPendentesBloqueantes,
};
