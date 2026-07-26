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

/** Janela em que um job IMPRESSO ainda bloqueia reenvio com a mesma chave. */
const IMPRESSO_TTL_MS = parseInt(
  process.env.PRINT_IDEMPOTENCY_TTL_MS || String(24 * 60 * 60 * 1000),
  10,
);

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

/**
 * Resolve chave estável. Sem chave → sem dedup (ex.: teste manual).
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

  if (op !== "imprimirPedido") return null;
  const payload = args?.[0];
  if (!payload || typeof payload !== "object") return null;

  // Job da nuvem (comanda) — uma via física por jobId.
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
 * @param {{ status: string, impresso_em?: string | null, criado_em?: string }} row
 */
function deveDeduplicar(row) {
  if (!row || !DEDUP_STATUSES.has(row.status)) return false;
  if (row.status !== "IMPRESSO") return true;
  const ts = row.impresso_em || row.criado_em;
  if (!ts) return true;
  const age = Date.now() - new Date(ts).getTime();
  return age >= 0 && age < IMPRESSO_TTL_MS;
}

module.exports = {
  resolveIdempotencyKey,
  fingerprintPedido,
  deveDeduplicar,
  DEDUP_STATUSES,
  IMPRESSO_TTL_MS,
};
