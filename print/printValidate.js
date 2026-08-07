/**
 * Validação pré-enfileiramento — etapa obrigatória do pipeline de impressão.
 */
const { normalizarCupomPayload, deveRelaxarQr } = require("./cupomValidate");

const OPS_CAIXA = new Set([
  "imprimirAbertura",
  "imprimirFechamento",
  "imprimirMovimentoCaixa",
]);

function validarAntesEnfileirar(op, args) {
  const payload = args?.[0];

  if (op === "imprimirTeste" || op === "abrirGaveta") {
    return { ok: true, args };
  }

  if (op === "imprimirSegundaVia") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Dados insuficientes para segunda via.");
    }
    const normalizado = normalizarCupomPayload(
      { ...payload, segundaVia: true, reimpressao: true },
      { relaxQr: true },
    );
    return { ok: true, args: [normalizado] };
  }

  if (op === "imprimirCupom") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload de cupom inválido.");
    }
    if (deveRelaxarQr(payload)) {
      const normalizado = normalizarCupomPayload(payload);
      return { ok: true, args: [normalizado] };
    }
    const normalizado = normalizarCupomPayload(payload);
    return { ok: true, args: [normalizado] };
  }

  if (OPS_CAIXA.has(op)) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Dados do comprovante de caixa inválidos.");
    }
    if (!String(payload.operador || "").trim()) {
      throw new Error("Operador obrigatório para comprovante de caixa.");
    }
    return { ok: true, args: [payload] };
  }

  if (op === "imprimirPedido") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload de pedido inválido.");
    }
    const { normalizarPedidoPayload } = require("./pedidoPrint");
    const normalizado = normalizarPedidoPayload(payload);
    if (!normalizado.orderNumber && !normalizado.jobId) {
      throw new Error("Pedido sem identificador (orderNumber ou jobId).");
    }
    return { ok: true, args: [normalizado] };
  }

  if (op === "imprimirVasilhame") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload de vasilhame inválido.");
    }
    const { normalizarVasilhamePayload } = require("./vasilhameAcbrTags");
    const normalizado = normalizarVasilhamePayload(payload);
    if (!normalizado.codigoTransacao) {
      throw new Error("Comprovante de vasilhame sem código de transação.");
    }
    return { ok: true, args: [normalizado] };
  }

  if (op === "imprimirCrediario") {
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload de crediário inválido.");
    }
    const { normalizarCrediarioPayload } = require("./crediarioAcbrTags");
    const normalizado = normalizarCrediarioPayload(payload);
    if (!(Number(normalizado.valorRecebido) > 0)) {
      throw new Error("Comprovante de crediário sem valor recebido.");
    }
    return { ok: true, args: [normalizado] };
  }

  if (typeof op !== "string" || !op) {
    throw new Error("Operação de impressão inválida.");
  }

  return { ok: true, args: args || [] };
}

module.exports = { validarAntesEnfileirar, OPS_CAIXA };
