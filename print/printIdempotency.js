/**
 * Idempotência de impressão térmica — evita reimpressão por retry/timeout/duplo clique.
 */
const crypto = require("crypto");

const DEDUP_STATUSES = new Set([
  "PENDENTE",
  "ENVIANDO",
  "REPROCESSANDO",
  "IMPRESSO",
]);

/** Janela em que um job IMPRESSO de pedido/comanda ainda bloqueia reenvio. */
const IMPRESSO_TTL_MS = parseInt(
  process.env.PRINT_IDEMPOTENCY_TTL_MS || String(24 * 60 * 60 * 1000),
  10,
);

/**
 * TTL curto para cupom/caixa — só anti-retry do front (AbortError ~25s).
 * 2ª via intencional após isso deve imprimir de novo.
 */
const CUPOM_IMPRESSO_TTL_MS = parseInt(
  process.env.PRINT_CUPOM_IDEMPOTENCY_TTL_MS || "180000",
  10,
);

const CUPOM_TIPOS = new Set([
  "cupom_fiscal",
  "cupom_nao_fiscal",
  "segunda_via",
  "danfe_termico",
  "abertura_caixa",
  "fechamento_caixa",
  "movimento_caixa",
  "sangria",
  "suprimento",
  "reimpressao",
  "teste",
  "gaveta",
  "relatorio",
]);

function stableHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 24);
}

function fingerprintPedido(payload) {
  if (!payload || typeof payload !== "object") return "empty";
  const items = Array.isArray(payload.items)
    ? payload.items.map((it) => ({
        c: String(it.code ?? it.codigo ?? ""),
        n: String(it.name ?? it.nome ?? ""),
        q: Number(it.quantity ?? it.quantidade ?? 0),
        t: Number(it.lineTotal ?? it.total ?? 0),
      }))
    : [];
  return stableHash({
    orderId: String(payload.orderId ?? ""),
    printType: String(payload.printType ?? ""),
    eventType: String(payload.eventType ?? ""),
    tableCode: String(payload.tableCode ?? payload.table_code ?? ""),
    total: Number(payload.total ?? 0),
    copies: Number(payload.copies ?? 1),
    items,
  });
}

function fingerprintCupom(payload) {
  if (!payload || typeof payload !== "object") return "empty";
  const itens = Array.isArray(payload.itens)
    ? payload.itens.map((it) => ({
        c: String(it.codigo ?? it.code ?? ""),
        n: String(it.nome ?? it.name ?? ""),
        q: Number(it.quantidade ?? it.quantity ?? 0),
        t: Number(it.total ?? it.lineTotal ?? 0),
      }))
    : [];
  return stableHash({
    total: Number(payload.total ?? 0),
    emitidoEm: String(payload.emitidoEm || "").slice(0, 19),
    forma: String(payload.formaPagamento || ""),
    itens,
  });
}

function isSegundaViaIntencional(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.reimpressao === true) return true;
  const motivo = String(payload.motivo || "").toLowerCase();
  if (/segunda_via|reimpressao|reimprimir/.test(motivo)) return true;
  // segundaVia sozinho NÃO basta — cupom auxiliar do checkout já usava o flag
  // por engano; exige reimpressao/motivo explícito OU op dedicada.
  return false;
}

/**
 * Resolve chave estável. Sem chave → sem dedup (ex.: teste manual sem número).
 * @returns {string | null}
 */
function resolveIdempotencyKey(op, args, opts = {}) {
  if (opts.force === true || opts.forceNew === true) return null;
  const explicit =
    opts.idempotencyKey ||
    opts.idempotency_key ||
    (args?.[0] && typeof args[0] === "object"
      ? args[0].idempotencyKey || args[0].idempotency_key
      : null);
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim().slice(0, 190);
  }

  const payload = args?.[0];
  if (!payload || typeof payload !== "object") return null;

  if (
    op === "imprimirCupom" ||
    op === "imprimirSegundaVia" ||
    op === "imprimirAbertura" ||
    op === "imprimirFechamento" ||
    op === "imprimirMovimentoCaixa"
  ) {
    const numero =
      payload.numeroVenda ||
      payload.numero ||
      payload.idVenda ||
      payload.vendaId ||
      payload.correlationId ||
      null;
    const sv = op === "imprimirSegundaVia" || isSegundaViaIntencional(payload);
    const tipo = sv
      ? "sv"
      : payload.naoFiscal || payload.cupomSemFiscal
        ? "nf"
        : "cupom";

    if (numero != null && String(numero).trim()) {
      // 2ª via intencional: inclui hash curto do horário para permitir várias vias
      // sem bloquear, mas ainda deduplica retries no mesmo segundo
      if (sv) {
        const slot = String(payload.emitidoEm || Date.now()).slice(0, 16);
        return `${op}:${tipo}:${String(numero).trim()}:${slot}`.slice(0, 190);
      }
      return `${op}:${tipo}:${String(numero).trim()}`.slice(0, 190);
    }

    if (op === "imprimirAbertura" || op === "imprimirFechamento") {
      const caixa = String(payload.caixa || payload.numeroCaixa || "main");
      const ts = String(payload.emitidoEm || payload.aberturaEm || "").slice(0, 16);
      if (ts) return `${op}:${caixa}:${ts}`.slice(0, 190);
    }

    // Sem número — fingerprint anti-retry (AbortError) sem bloquear 2ª via por 24h
    return `${op}:${tipo}:fp:${fingerprintCupom(payload)}`.slice(0, 190);
  }

  if (op === "imprimirVasilhame" || op === "imprimirCrediario") {
    const codigo =
      payload.codigoTransacao ||
      payload.codigo ||
      payload.correlationId ||
      payload.numeroParcela ||
      null;
    const clickId = String(payload.clickId || payload.click_id || "").trim();
    const motivo = String(payload.motivo || "").toLowerCase();
    const reimpressao =
      /reimpress|segunda/.test(motivo) || clickId.length > 0;
    if (op === "imprimirVasilhame") {
      const cod = String(codigo || "").trim().toUpperCase();
      if (!cod) return null;
      // Auto pós-saída: só código (retry Abort = 1 folha).
      // Reimpressão intencional: clickId estável por clique.
      if (reimpressao && clickId) {
        return `vasilhame:sv:${cod}:${clickId}`.slice(0, 190);
      }
      return `vasilhame:${cod}`.slice(0, 190);
    }
    // Crediário: fingerprint + click opcional
    const fp = fingerprintCupom(payload);
    if (reimpressao && clickId) {
      return `crediario:sv:${fp}:${clickId}`.slice(0, 190);
    }
    return `crediario:${fp}`.slice(0, 190);
  }

  if (op === "imprimirRelatorio") {
    const clickId = String(payload.clickId || payload.click_id || "").trim();
    const numeros = (Array.isArray(payload.vendas) ? payload.vendas : [])
      .map((v) => String(v.numero || v.numeroVenda || "").trim())
      .filter(Boolean)
      .sort();
    const fp = fingerprintCupom({
      total: payload.faturamento,
      itens: payload.itens,
    });
    if (clickId) {
      return `relatorio:${clickId}`.slice(0, 190);
    }
    return `relatorio:fp:${numeros.join(",")}:${fp}`.slice(0, 190);
  }

  if (op !== "imprimirPedido") return null;

  const cloudJobId = payload.jobId || payload.job_id;
  if (cloudJobId != null && String(cloudJobId).trim()) {
    return `cloud:${String(cloudJobId).trim()}`.slice(0, 190);
  }

  const orderId = payload.orderId || payload.order_id;
  const eventType = String(payload.eventType || payload.event_type || "");
  if (eventType === "PRE_CONTA" && orderId) {
    return `preconta:${String(orderId)}:${fingerprintPedido(payload)}`.slice(0, 190);
  }

  if (orderId) {
    return `pedido:${String(payload.printType || "x")}:${eventType}:${String(orderId)}:${fingerprintPedido(payload)}`.slice(
      0,
      190,
    );
  }
  return null;
}

/**
 * @param {{ status: string, tipo?: string, impresso_em?: string | null, criado_em?: string }} row
 */
function deveDeduplicar(row) {
  if (!row || !DEDUP_STATUSES.has(row.status)) return false;
  if (row.status !== "IMPRESSO") return true;
  const ts = row.impresso_em || row.criado_em;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  if (age < 0) return true;
  const ttl = CUPOM_TIPOS.has(String(row.tipo || ""))
    ? CUPOM_IMPRESSO_TTL_MS
    : IMPRESSO_TTL_MS;
  return age < ttl;
}

module.exports = {
  resolveIdempotencyKey,
  fingerprintPedido,
  fingerprintCupom,
  isSegundaViaIntencional,
  deveDeduplicar,
  DEDUP_STATUSES,
  IMPRESSO_TTL_MS,
  CUPOM_IMPRESSO_TTL_MS,
};
