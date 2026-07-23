/**
 * IBPT (Lei 12.741/2012) — consumo do valor calculado pelo backend.
 * O agente não recalcula: payload.ibpt vem de preparar-emissao-nfce / documentIni (MFCS).
 * Nunca aplica em cupom auxiliar / não fiscal.
 */

function ehCupomNaoFiscal(payload) {
  if (payload?.naoFiscal === true || payload?.cupomSemFiscal === true) return true;
  if (payload?.status === "CANCELADA" || payload?.statusFiscal === "CANCELADA") {
    return true;
  }
  return false;
}

function resolverIbptCupom(payload) {
  if (ehCupomNaoFiscal(payload)) return null;
  const ibptTotal = Number(payload?.ibpt?.total);
  if (Number.isFinite(ibptTotal) && ibptTotal > 0) {
    return payload.ibpt;
  }
  if (payload?.itens?.length) {
    console.warn(
      "[IBPT] payload sem ibpt do backend — linha omitida (use preparar-emissao-nfce ou documentIni)",
    );
  }
  return null;
}

function formatarTextoIbptCupom(ibpt, totalVenda) {
  const total = Number(ibpt?.total || 0);
  const venda = Number(totalVenda || 0);
  if (!total || total <= 0 || !venda || venda <= 0) return "";
  const pct =
    Number(ibpt.percentualTotal) > 0
      ? Number(ibpt.percentualTotal)
      : Math.round((total / venda) * 10000) / 100;
  const valor = total.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pctFmt = pct.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `Trib. aprox.: R$ ${valor} (${pctFmt}%) Fonte: IBPT`;
}

module.exports = {
  resolverIbptCupom,
  formatarTextoIbptCupom,
  ehCupomNaoFiscal,
};
